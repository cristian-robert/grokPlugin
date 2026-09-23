// @ts-check
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";

/**
 * @param {string} cwd
 * @param {string[]} args
 */
export function git(cwd, args) {
  const result = spawnSync("git", args, { cwd, encoding: "utf8", shell: false });
  if (result.status !== 0) {
    throw new Error(`git ${args.join(" ")}: ${result.stderr}`);
  }
  return result.stdout;
}

/**
 * Temp repo on `main` with one commit. Caller removes it with `cleanup`.
 * @param {Record<string, string>} [files]
 */
export function makeRepo(files = { "a.txt": "one\n" }) {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "grok-plugin-test-")));
  git(dir, ["init", "-q", "-b", "main"]);
  git(dir, ["config", "user.email", "test@example.com"]);
  git(dir, ["config", "user.name", "test"]);
  git(dir, ["config", "core.autocrlf", "false"]);
  for (const [name, content] of Object.entries(files)) {
    write(dir, name, content);
  }
  git(dir, ["add", "-A"]);
  git(dir, ["commit", "-q", "-m", "init"]);
  return dir;
}

/**
 * @param {string} dir
 * @param {string} name
 * @param {string} content
 */
export function write(dir, name, content) {
  const file = path.join(dir, name);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content);
}

/** @param {string} dir */
export function cleanup(dir) {
  fs.rmSync(dir, { recursive: true, force: true });
}
