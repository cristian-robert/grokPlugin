// @ts-check
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";

import { findExecutable } from "./exec.mjs";

const MAX_OUTPUT_BYTES = 256 * 1024 * 1024;
// Lists and diffs that only feed the prompt: anything past this is truncated anyway.
const MAX_CONTEXT_OUTPUT_BYTES = 8 * 1024 * 1024;
/** @type {string | null} */
let resolvedGit = null;

function gitBinary() {
  resolvedGit ??= findExecutable("git", process.env, process.platform);
  if (!resolvedGit) {
    throw new Error("git is not installed or not on PATH.");
  }
  return resolvedGit;
}
const MAX_UNTRACKED_FILE_BYTES = 24 * 1024;
const MAX_INLINED_UNTRACKED_FILES = 200;
export const DEFAULT_MAX_CONTEXT_BYTES = 300 * 1024;
// Repo content is untrusted: never let a diff run repo-configured external programs.
const SAFE_DIFF_FLAGS = ["--no-ext-diff", "--no-textconv", "--no-color"];

/**
 * @typedef {{ status: number, stdout: string, stderr: string, truncated: boolean }} GitResult
 * @typedef {{ mode: "working-tree" | "branch", label: string, baseRef: string | null }} ReviewTarget
 * @typedef {{ summary: string, changedFiles: string[], content: string, truncated: boolean }} ReviewContext
 */

/** @type {string | null} */
let outputDir = null;
let outputCounter = 0;

/** Scratch directory for git output files, removed when the process exits. */
function gitOutputDir() {
  if (!outputDir) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "grok-git-"));
    process.once("exit", () => fs.rmSync(dir, { recursive: true, force: true }));
    outputDir = dir;
  }
  return outputDir;
}

/**
 * Runs git without a shell; arguments never pass through shell parsing on any platform.
 * stdout goes to a temp file rather than a pipe buffer, so a huge listing or diff can't fail
 * with ENOBUFS; at most `maxBytes` of it is read back.
 * @param {string} cwd
 * @param {string[]} args
 * @param {{ maxBytes?: number }} [options]
 * @returns {GitResult}
 */
export function runGit(cwd, args, options = {}) {
  const maxBytes = options.maxBytes ?? MAX_OUTPUT_BYTES;
  outputCounter += 1;
  const outFile = path.join(gitOutputDir(), `${outputCounter}.out`);
  const fd = fs.openSync(outFile, "w");
  let result;
  try {
    // core.fsmonitor and gpg.program name programs git would run; a planted value must never execute.
    result = spawnSync(gitBinary(), ["--no-optional-locks", "-c", "core.fsmonitor=false", "-c", "log.showSignature=false", ...args], {
      cwd,
      shell: false,
      windowsHide: true,
      stdio: ["ignore", fd, "pipe"],
      maxBuffer: 16 * 1024 * 1024,
      encoding: "utf8"
    });
  } finally {
    fs.closeSync(fd);
  }
  try {
    if (result.error) {
      const code = /** @type {NodeJS.ErrnoException} */ (result.error).code;
      throw new Error(code === "ENOENT" ? "git is not installed or not on PATH." : `git ${args.join(" ")} failed: ${result.error.message}`);
    }
    const size = fs.statSync(outFile).size;
    const length = Math.min(size, maxBytes);
    const buffer = Buffer.alloc(length);
    const readFd = fs.openSync(outFile, "r");
    try {
      fs.readSync(readFd, buffer, 0, length, 0);
    } finally {
      fs.closeSync(readFd);
    }
    return { status: result.status ?? 1, stdout: buffer.toString("utf8"), stderr: result.stderr ?? "", truncated: size > maxBytes };
  } finally {
    fs.rmSync(outFile, { force: true });
  }
}

/**
 * @param {string} cwd
 * @param {string[]} args
 * @returns {string} full stdout; throws if it exceeds the output limit
 */
export function gitChecked(cwd, args) {
  const result = runGit(cwd, args);
  if (result.status !== 0) {
    throw new Error(`git ${args.join(" ")} failed: ${result.stderr.trim() || `exit ${result.status}`}`);
  }
  if (result.truncated) {
    throw new Error(`git ${args.join(" ")} produced more than ${MAX_OUTPUT_BYTES / (1024 * 1024)} MB of output. Add large generated or dependency folders to .gitignore and retry.`);
  }
  return result.stdout;
}

/**
 * Like gitChecked, but returns at most `maxBytes` of output instead of failing on large output.
 * @param {string} cwd
 * @param {string[]} args
 * @param {number} maxBytes
 * @returns {{ stdout: string, truncated: boolean }}
 */
export function gitCapped(cwd, args, maxBytes) {
  const result = runGit(cwd, args, { maxBytes });
  if (result.status !== 0) {
    throw new Error(`git ${args.join(" ")} failed: ${result.stderr.trim() || `exit ${result.status}`}`);
  }
  return { stdout: result.stdout, truncated: result.truncated };
}

/**
 * NUL-separated records from possibly truncated output; a cut-off final record is dropped.
 * @param {{ stdout: string, truncated: boolean }} output
 */
export function splitNulCapped(output) {
  const records = splitNul(output.stdout);
  if (output.truncated && !output.stdout.endsWith("\0")) {
    records.pop();
  }
  return records;
}

/** @param {string} output */
export function splitNul(output) {
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
export function hasCommits(cwd) {
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
 * Output for the prompt only: bounded, with a visible marker when cut.
 * @param {string} root
 * @param {string[]} args
 */
function capped(root, args) {
  const { stdout, truncated } = gitCapped(root, args, MAX_CONTEXT_OUTPUT_BYTES);
  return truncated ? `${stdout}\n[git output truncated at ${MAX_CONTEXT_OUTPUT_BYTES / (1024 * 1024)} MB]` : stdout;
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
    const list = (/** @type {string[]} */ gitArgs) => splitNulCapped(gitCapped(root, gitArgs, MAX_CONTEXT_OUTPUT_BYTES));
    const staged = hasCommits(root) ? list(["diff", "--cached", "--name-only", "-z"]) : list(["ls-files", "-z"]);
    const unstaged = list(["diff", "--name-only", "-z"]);
    const untracked = list(["ls-files", "--others", "--exclude-standard", "-z"]);
    const changedFiles = [...new Set([...staged, ...unstaged, ...untracked])].sort();
    if (changedFiles.length === 0) {
      throw new Error("Nothing to review: the working tree is clean. Try --scope branch or --base <ref>.");
    }
    const stagedDiff = hasCommits(root)
      ? capped(root, ["diff", "--cached", ...SAFE_DIFF_FLAGS])
      : capped(root, ["diff", "--cached", "--root", ...SAFE_DIFF_FLAGS]);
    const { content, truncated } = joinWithinBudget(
      [
        section("Changed Files", changedFiles.join("\n")),
        section("Diff Stat", hasCommits(root) ? capped(root, ["diff", "--stat", ...SAFE_DIFF_FLAGS, "HEAD"]) : "(no commits yet)"),
        section("Git Status", capped(root, ["status", "--short", "--untracked-files=all"])),
        section("Staged Diff", stagedDiff),
        section("Unstaged Diff", capped(root, ["diff", ...SAFE_DIFF_FLAGS])),
        section(
          "Untracked Files",
          [
            ...untracked.slice(0, MAX_INLINED_UNTRACKED_FILES).map((file) => describeUntracked(root, file)),
            ...untracked.slice(MAX_INLINED_UNTRACKED_FILES).map((file) => `### ${file}\n(not inlined; read it with read_file if relevant)`)
          ].join("\n\n")
        )
      ],
      maxBytes
    );
    return {
      summary: `${staged.length} staged, ${unstaged.length} unstaged, ${untracked.length} untracked file(s).`,
      changedFiles,
      content,
      truncated
    };
  }

  const baseRef = /** @type {string} */ (target.baseRef);
  const mergeBase = gitChecked(root, ["merge-base", "HEAD", "--end-of-options", baseRef]).trim();
  const range = `${mergeBase}..HEAD`;
  const changedFiles = splitNulCapped(gitCapped(root, ["diff", "--name-only", "-z", range], MAX_CONTEXT_OUTPUT_BYTES));
  if (changedFiles.length === 0) {
    throw new Error(`Nothing to review: HEAD has no changes against ${baseRef}.`);
  }
  const { content, truncated } = joinWithinBudget(
    [
      section("Changed Files", changedFiles.join("\n")),
      section("Commit Log", capped(root, ["log", "--oneline", "--no-decorate", range])),
      section("Diff Stat", capped(root, ["diff", "--stat", ...SAFE_DIFF_FLAGS, range])),
      section("Branch Diff", capped(root, ["diff", ...SAFE_DIFF_FLAGS, range]))
    ],
    maxBytes
  );
  return {
    summary: `${changedFiles.length} file(s) changed since merge-base ${mergeBase.slice(0, 12)} with ${baseRef}.`,
    changedFiles,
    content,
    truncated
  };
}
