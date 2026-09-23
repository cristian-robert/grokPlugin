// @ts-check
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import { gitChecked, runGit } from "./git.mjs";

const MAX_HASHED_FILE_BYTES = 64 * 1024 * 1024;

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
 * Snapshot of everything a review must not change: commits, refs, index, and every
 * modified or untracked file's content. Ignored files are tracked by path only.
 * @param {string} root
 * @returns {Fingerprint}
 */
export function computeFingerprint(root) {
  /** @type {Fingerprint} */
  const entries = new Map();
  const head = runGit(root, ["rev-parse", "--verify", "--quiet", "HEAD"]);
  entries.set("@HEAD", head.status === 0 ? head.stdout.trim() : "none");
  entries.set("@refs", sha256(gitChecked(root, ["for-each-ref", "--format=%(refname) %(objectname)"])));
  entries.set("@index", sha256(gitChecked(root, ["ls-files", "--stage", "-z"])));
  entries.set("@ignored", sha256(gitChecked(root, ["ls-files", "--others", "--ignored", "--exclude-standard", "--directory", "-z"])));

  const status = gitChecked(root, ["status", "--porcelain=v1", "-z", "--untracked-files=all", "--no-renames"]);
  for (const record of status.split("\0").filter(Boolean)) {
    const code = record.slice(0, 2);
    const relative = record.slice(3);
    entries.set(relative, `${code}|${hashPath(path.join(root, relative))}`);
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
