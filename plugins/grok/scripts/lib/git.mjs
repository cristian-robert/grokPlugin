// @ts-check
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";

const MAX_BUFFER = 256 * 1024 * 1024;
const MAX_UNTRACKED_FILE_BYTES = 24 * 1024;
export const DEFAULT_MAX_CONTEXT_BYTES = 300 * 1024;
// Repo content is untrusted: never let a diff run repo-configured external programs.
const SAFE_DIFF_FLAGS = ["--no-ext-diff", "--no-textconv", "--no-color"];

/**
 * @typedef {{ status: number, stdout: string, stderr: string }} GitResult
 * @typedef {{ mode: "working-tree" | "branch", label: string, baseRef: string | null }} ReviewTarget
 * @typedef {{ label: string, summary: string, changedFiles: string[], content: string, truncated: boolean }} ReviewContext
 */

/**
 * Runs git without a shell; arguments never pass through shell parsing on any platform.
 * @param {string} cwd
 * @param {string[]} args
 * @returns {GitResult}
 */
export function runGit(cwd, args) {
  const result = spawnSync("git", ["--no-optional-locks", ...args], {
    cwd,
    shell: false,
    windowsHide: true,
    maxBuffer: MAX_BUFFER,
    encoding: "utf8"
  });
  if (result.error) {
    const code = /** @type {NodeJS.ErrnoException} */ (result.error).code;
    throw new Error(code === "ENOENT" ? "git is not installed or not on PATH." : `git failed: ${result.error.message}`);
  }
  return { status: result.status ?? 1, stdout: result.stdout, stderr: result.stderr };
}

/**
 * @param {string} cwd
 * @param {string[]} args
 */
export function gitChecked(cwd, args) {
  const result = runGit(cwd, args);
  if (result.status !== 0) {
    throw new Error(`git ${args.join(" ")} failed: ${result.stderr.trim() || `exit ${result.status}`}`);
  }
  return result.stdout;
}

/** @param {string} output */
function splitNul(output) {
  return output.split("\0").filter(Boolean);
}

/** @param {string} cwd */
export function getRepoRoot(cwd) {
  const result = runGit(cwd, ["rev-parse", "--show-toplevel"]);
  if (result.status !== 0) {
    throw new Error("This command must run inside a Git repository.");
  }
  return path.resolve(result.stdout.trim());
}

/** @param {string} cwd */
function hasCommits(cwd) {
  return runGit(cwd, ["rev-parse", "--verify", "--quiet", "HEAD"]).status === 0;
}

/**
 * @param {string} cwd
 * @param {string} ref
 */
function verifyCommit(cwd, ref) {
  const result = runGit(cwd, ["rev-parse", "--verify", "--quiet", "--end-of-options", `${ref}^{commit}`]);
  if (result.status !== 0) {
    throw new Error(`Base ref "${ref}" does not resolve to a commit.`);
  }
}

/** @param {string} cwd */
export function detectDefaultBranch(cwd) {
  const symbolic = runGit(cwd, ["symbolic-ref", "--quiet", "refs/remotes/origin/HEAD"]);
  if (symbolic.status === 0) {
    const ref = symbolic.stdout.trim();
    if (ref.startsWith("refs/remotes/")) {
      return ref.slice("refs/remotes/".length);
    }
  }
  for (const candidate of ["main", "master", "trunk"]) {
    if (runGit(cwd, ["show-ref", "--verify", "--quiet", `refs/heads/${candidate}`]).status === 0) {
      return candidate;
    }
    if (runGit(cwd, ["show-ref", "--verify", "--quiet", `refs/remotes/origin/${candidate}`]).status === 0) {
      return `origin/${candidate}`;
    }
  }
  throw new Error("Unable to detect the default branch. Pass --base <ref> or --scope working-tree.");
}

/** @param {string} cwd */
function isDirty(cwd) {
  return gitChecked(cwd, ["status", "--porcelain=v1", "-z", "--untracked-files=all"]).length > 0;
}

/**
 * @param {string} cwd
 * @param {{ scope: "auto" | "working-tree" | "branch", base: string | null }} options
 * @returns {ReviewTarget}
 */
export function resolveTarget(cwd, options) {
  if (options.base) {
    verifyCommit(cwd, options.base);
    return { mode: "branch", label: `branch diff against ${options.base}`, baseRef: options.base };
  }
  if (options.scope === "working-tree" || (options.scope === "auto" && (isDirty(cwd) || !hasCommits(cwd)))) {
    return { mode: "working-tree", label: "working tree diff", baseRef: null };
  }
  const base = detectDefaultBranch(cwd);
  verifyCommit(cwd, base);
  return { mode: "branch", label: `branch diff against ${base}`, baseRef: base };
}

/**
 * @param {string} title
 * @param {string} body
 */
function section(title, body) {
  return `## ${title}\n\n${body.trim() || "(none)"}\n`;
}

/** @param {Buffer} buffer */
function looksBinary(buffer) {
  return buffer.subarray(0, 8000).includes(0);
}

/**
 * @param {string} root
 * @param {string} relativePath
 */
function describeUntracked(root, relativePath) {
  const absolute = path.join(root, relativePath);
  try {
    const stat = fs.lstatSync(absolute);
    if (!stat.isFile()) {
      return `### ${relativePath}\n(skipped: not a regular file)`;
    }
    if (stat.size > MAX_UNTRACKED_FILE_BYTES) {
      return `### ${relativePath}\n(skipped: ${stat.size} bytes; read it with read_file if relevant)`;
    }
    const buffer = fs.readFileSync(absolute);
    if (looksBinary(buffer)) {
      return `### ${relativePath}\n(skipped: binary)`;
    }
    return `### ${relativePath}\n\`\`\`\n${buffer.toString("utf8").trimEnd()}\n\`\`\``;
  } catch {
    return `### ${relativePath}\n(skipped: unreadable)`;
  }
}

/**
 * Keeps the prompt bounded. Grok can still read_file anything that was cut.
 * @param {string[]} sections
 * @param {number} maxBytes
 */
function joinWithinBudget(sections, maxBytes) {
  let remaining = maxBytes;
  let truncated = false;
  const kept = sections.map((text) => {
    const size = Buffer.byteLength(text, "utf8");
    if (size <= remaining) {
      remaining -= size;
      return text;
    }
    truncated = true;
    const slice = Buffer.from(text, "utf8").subarray(0, Math.max(0, remaining)).toString("utf8");
    remaining = 0;
    return `${slice}\n\n[truncated: ${size - Buffer.byteLength(slice, "utf8")} bytes omitted. Use read_file on the changed files to review the rest.]\n`;
  });
  return { content: kept.join("\n"), truncated };
}

/**
 * @param {string} root
 * @param {ReviewTarget} target
 * @param {{ maxBytes?: number }} [options]
 * @returns {ReviewContext}
 */
export function collectContext(root, target, options = {}) {
  const maxBytes = options.maxBytes ?? DEFAULT_MAX_CONTEXT_BYTES;

  if (target.mode === "working-tree") {
    const staged = hasCommits(root) ? splitNul(gitChecked(root, ["diff", "--cached", "--name-only", "-z"])) : splitNul(gitChecked(root, ["ls-files", "-z"]));
    const unstaged = splitNul(gitChecked(root, ["diff", "--name-only", "-z"]));
    const untracked = splitNul(gitChecked(root, ["ls-files", "--others", "--exclude-standard", "-z"]));
    const changedFiles = [...new Set([...staged, ...unstaged, ...untracked])].sort();
    if (changedFiles.length === 0) {
      throw new Error("Nothing to review: the working tree is clean. Try --scope branch or --base <ref>.");
    }
    const stagedDiff = hasCommits(root)
      ? gitChecked(root, ["diff", "--cached", ...SAFE_DIFF_FLAGS])
      : gitChecked(root, ["diff", "--cached", "--root", ...SAFE_DIFF_FLAGS]);
    const { content, truncated } = joinWithinBudget(
      [
        section("Changed Files", changedFiles.join("\n")),
        section("Git Status", gitChecked(root, ["status", "--short", "--untracked-files=all"])),
        section("Staged Diff", stagedDiff),
        section("Unstaged Diff", gitChecked(root, ["diff", ...SAFE_DIFF_FLAGS])),
        section("Untracked Files", untracked.map((file) => describeUntracked(root, file)).join("\n\n"))
      ],
      maxBytes
    );
    return {
      label: target.label,
      summary: `${staged.length} staged, ${unstaged.length} unstaged, ${untracked.length} untracked file(s).`,
      changedFiles,
      content,
      truncated
    };
  }

  const baseRef = /** @type {string} */ (target.baseRef);
  const mergeBase = gitChecked(root, ["merge-base", "HEAD", "--end-of-options", baseRef]).trim();
  const range = `${mergeBase}..HEAD`;
  const changedFiles = splitNul(gitChecked(root, ["diff", "--name-only", "-z", range]));
  if (changedFiles.length === 0) {
    throw new Error(`Nothing to review: HEAD has no changes against ${baseRef}.`);
  }
  const { content, truncated } = joinWithinBudget(
    [
      section("Changed Files", changedFiles.join("\n")),
      section("Commit Log", gitChecked(root, ["log", "--oneline", "--no-decorate", range])),
      section("Diff Stat", gitChecked(root, ["diff", "--stat", ...SAFE_DIFF_FLAGS, range])),
      section("Branch Diff", gitChecked(root, ["diff", ...SAFE_DIFF_FLAGS, range]))
    ],
    maxBytes
  );
  return {
    label: target.label,
    summary: `${changedFiles.length} file(s) changed since merge-base ${mergeBase.slice(0, 12)} with ${baseRef}.`,
    changedFiles,
    content,
    truncated
  };
}
