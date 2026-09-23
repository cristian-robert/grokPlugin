// @ts-check
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import { gitChecked, hasCommits, splitNul } from "./git.mjs";

const MAX_HASHED_FILE_BYTES = 64 * 1024 * 1024;
const MAX_IGNORED_FILES = 200_000;
const MAX_SUBMODULE_DEPTH = 4;
export const IGNORED_TRUNCATED_KEY = "@ignored:truncated";

/** @typedef {Map<string, string>} Fingerprint */

/** @param {string | Buffer} data */
function sha256(data) {
  return crypto.createHash("sha256").update(data).digest("hex");
}

/**
 * Raw bytes, so CRLF files hash identically before and after.
 * @param {string} absolute
 */
function hashPath(absolute) {
  try {
    const stat = fs.lstatSync(absolute);
    if (stat.isSymbolicLink()) {
      return `link:${sha256(fs.readlinkSync(absolute))}`;
    }
    if (stat.isDirectory()) {
      return "dir";
    }
    if (stat.size > MAX_HASHED_FILE_BYTES) {
      return `large:${stat.size}:${stat.mtimeMs}`;
    }
    return `file:${sha256(fs.readFileSync(absolute))}`;
  } catch {
    return "missing";
  }
}

/**
 * @param {string} dir
 * @returns {string[]} absolute paths of every non-directory entry below dir
 */
function walk(dir) {
  /** @type {fs.Dirent[]} */
  let dirents;
  try {
    dirents = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return [];
  }
  return dirents.flatMap((entry) => {
    const absolute = path.join(dir, entry.name);
    return entry.isDirectory() ? walk(absolute) : [absolute];
  });
}

/**
 * Git internals that change behavior without changing status or refs: which branch HEAD
 * points to, config (core.hooksPath, core.fsmonitor, aliases, diff drivers), info/, and hooks.
 * @param {string} root
 * @param {Fingerprint} entries
 */
function addGitInternals(root, entries) {
  const gitDir = gitChecked(root, ["rev-parse", "--absolute-git-dir"]).trim();
  const commonDir = path.resolve(root, gitChecked(root, ["rev-parse", "--git-common-dir"]).trim());
  const isModuleControlFile = (/** @type {string} */ file) => {
    const parts = path.relative(path.join(commonDir, "modules"), file).split(path.sep);
    return ["HEAD", "config", "config.worktree"].includes(parts[parts.length - 1]) || parts.includes("hooks") || parts.includes("info");
  };
  const files = [
    path.join(gitDir, "HEAD"),
    path.join(gitDir, "config.worktree"),
    path.join(commonDir, "config"),
    ...walk(path.join(commonDir, "info")),
    ...walk(path.join(commonDir, "hooks")),
    // Submodule repositories live here: their config and hooks run code just like the parent's.
    ...walk(path.join(commonDir, "modules")).filter((file) => !file.includes(`${path.sep}objects${path.sep}`) && isModuleControlFile(file))
  ];
  for (const file of new Set(files)) {
    entries.set(`@git:${path.relative(commonDir, file) || file}`, hashPath(file));
  }
}

/**
 * Ignored files (node_modules, .env, build output) can be huge, so they are compared by
 * size and mtime rather than content, up to a cap.
 * @param {string} root
 * @param {Fingerprint} entries
 */
function addIgnoredFiles(root, entries) {
  const ignored = splitNul(gitChecked(root, ["ls-files", "--others", "--ignored", "--exclude-standard", "-z"]));
  for (const relative of ignored.slice(0, MAX_IGNORED_FILES)) {
    let state = "missing";
    try {
      const stat = fs.lstatSync(path.join(root, relative));
      state = `${stat.size}:${stat.mtimeMs}`;
    } catch {
      // vanished between listing and stat; "missing" still compares correctly
    }
    entries.set(`@ignored:${relative}`, state);
  }
  if (ignored.length > MAX_IGNORED_FILES) {
    entries.set(IGNORED_TRUNCATED_KEY, String(ignored.length));
  }
}

/**
 * Snapshot of everything a review must not change: commits, refs, index, git internals,
 * every modified or untracked file's content, and ignored files' size and mtime.
 * @param {string} root
 * @param {number} [depth] submodule nesting level
 * @returns {Fingerprint}
 */
export function computeFingerprint(root, depth = 0) {
  /** @type {Fingerprint} */
  const entries = new Map();
  entries.set("@HEAD", hasCommits(root) ? gitChecked(root, ["rev-parse", "HEAD"]).trim() : "none");
  entries.set("@refs", sha256(gitChecked(root, ["for-each-ref", "--format=%(refname) %(objectname)"])));
  const stage = gitChecked(root, ["ls-files", "--stage", "-z"]);
  entries.set("@index", sha256(stage));
  // Tag letters expose skip-worktree (S) and assume-unchanged (lowercase) entries. git status
  // never reports edits to those files, so their bytes are hashed directly.
  const tagged = gitChecked(root, ["ls-files", "-v", "-z"]);
  entries.set("@index-flags", sha256(tagged));
  for (const record of splitNul(tagged)) {
    const tag = record[0];
    if (tag === "S" || tag !== tag.toUpperCase()) {
      const relative = record.slice(2);
      entries.set(`@flagged:${relative}`, hashPath(path.join(root, relative)));
    }
  }
  addGitInternals(root, entries);
  addIgnoredFiles(root, entries);

  const status = gitChecked(root, ["status", "--porcelain=v1", "-z", "--untracked-files=all", "--no-renames", "--ignore-submodules=none"]);
  for (const record of splitNul(status)) {
    const code = record.slice(0, 2);
    const relative = record.slice(3);
    entries.set(relative, `${code}|${hashPath(path.join(root, relative))}`);
  }

  // Submodules can hide their own changes from the parent (e.g. `ignore = all` in .gitmodules),
  // so each checked-out submodule is fingerprinted as a repository of its own.
  if (depth < MAX_SUBMODULE_DEPTH) {
    for (const record of splitNul(stage)) {
      const [meta, relative] = record.split("\t");
      if (meta.startsWith("160000 ") && fs.existsSync(path.join(root, relative, ".git"))) {
        for (const [key, value] of computeFingerprint(path.join(root, relative), depth + 1)) {
          entries.set(`@sub:${relative}/${key}`, value);
        }
      }
    }
  }
  return entries;
}

// Places under ~/.grok where a write would persist into later, possibly unsandboxed, grok
// sessions: auto-trusted plugins, skills, agents, hooks, config, and the grok binary itself.
// managed_config.toml and requirements.toml are left out: grok's managed-config sync rewrites
// them on every launch, and they can only tighten policy.
const GROK_HOME_PERSISTENCE = [
  "plugins", "skills", "agents", "hooks", "hooks-paths", "bin", "config.toml", "sandbox.toml", "trusted_folders.toml"
];

/**
 * @param {string} grokHome
 * @returns {Fingerprint}
 */
export function computeGrokHomeFingerprint(grokHome) {
  /** @type {Fingerprint} */
  const entries = new Map();
  for (const entry of GROK_HOME_PERSISTENCE) {
    const absolute = path.join(grokHome, entry);
    const files = fs.existsSync(absolute) && fs.statSync(absolute).isDirectory() ? walk(absolute) : [absolute];
    for (const file of files) {
      entries.set(`@grok-home:${path.relative(grokHome, file)}`, hashPath(file));
    }
  }
  return entries;
}

/**
 * @param {Fingerprint} before
 * @param {Fingerprint} after
 * @returns {string[]} keys whose state differs, sorted
 */
export function diffFingerprints(before, after) {
  const keys = new Set([...before.keys(), ...after.keys()]);
  return [...keys].filter((key) => before.get(key) !== after.get(key)).sort();
}
