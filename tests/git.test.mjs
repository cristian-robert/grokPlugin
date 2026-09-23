// @ts-check
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

import { collectContext, getRepoRoot, resolveTarget } from "../plugins/grok/scripts/lib/git.mjs";
import { cleanup, git, makeRepo, write } from "./helpers.mjs";

test("auto scope picks working tree when dirty", (t) => {
  const repo = makeRepo();
  t.after(() => cleanup(repo));
  write(repo, "a.txt", "two\n");
  assert.equal(resolveTarget(repo, { scope: "auto", base: null }).mode, "working-tree");
});

test("auto scope picks branch vs default branch when clean", (t) => {
  const repo = makeRepo();
  t.after(() => cleanup(repo));
  git(repo, ["checkout", "-q", "-b", "feature"]);
  write(repo, "b.txt", "new\n");
  git(repo, ["add", "-A"]);
  git(repo, ["commit", "-q", "-m", "feature"]);
  const target = resolveTarget(repo, { scope: "auto", base: null });
  assert.deepEqual(target, { mode: "branch", label: "branch diff against main", baseRef: "main" });

  const context = collectContext(repo, target);
  assert.deepEqual(context.changedFiles, ["b.txt"]);
  assert.match(context.content, /## Branch Diff[\s\S]*\+new/);
  assert.match(context.content, /## Commit Log[\s\S]*feature/);
});

test("working tree context includes staged, unstaged and untracked content", (t) => {
  const repo = makeRepo({ "a.txt": "one\n", "s.txt": "s\n" });
  t.after(() => cleanup(repo));
  write(repo, "a.txt", "unstaged change\n");
  write(repo, "s.txt", "staged change\n");
  git(repo, ["add", "s.txt"]);
  write(repo, "dir/new.txt", "brand new\n");
  const context = collectContext(repo, resolveTarget(repo, { scope: "working-tree", base: null }));
  assert.deepEqual(context.changedFiles, ["a.txt", "dir/new.txt", "s.txt"]);
  assert.match(context.content, /## Staged Diff[\s\S]*\+staged change/);
  assert.match(context.content, /## Unstaged Diff[\s\S]*\+unstaged change/);
  assert.match(context.content, /### dir\/new.txt[\s\S]*brand new/);
  assert.equal(context.truncated, false);
});

test("clean working tree is an error, not an empty review", (t) => {
  const repo = makeRepo();
  t.after(() => cleanup(repo));
  assert.throws(() => collectContext(repo, { mode: "working-tree", label: "x", baseRef: null }), /Nothing to review/);
});

test("--base must resolve to a commit", (t) => {
  const repo = makeRepo();
  t.after(() => cleanup(repo));
  assert.throws(() => resolveTarget(repo, { scope: "auto", base: "does-not-exist" }), /does not resolve/);
});

test("context is truncated to the byte budget with a marker", (t) => {
  const repo = makeRepo();
  t.after(() => cleanup(repo));
  write(repo, "a.txt", "x".repeat(5000) + "\n");
  const context = collectContext(repo, resolveTarget(repo, { scope: "working-tree", base: null }), { maxBytes: 1000 });
  assert.equal(context.truncated, true);
  assert.match(context.content, /\[truncated: \d+ bytes omitted/);
  assert.ok(Buffer.byteLength(context.content) < 2000);
});

test("repo external diff drivers are never executed", (t) => {
  const repo = makeRepo({ "a.txt": "one\n", ".gitattributes": "*.txt diff=evil\n" });
  t.after(() => cleanup(repo));
  const marker = path.join(repo, "pwned");
  git(repo, ["config", "diff.evil.command", `node -e "require('fs').writeFileSync('${marker.replace(/\\/g, "/")}','x')"`]);
  git(repo, ["config", "diff.evil.textconv", `node -e "require('fs').writeFileSync('${marker.replace(/\\/g, "/")}','x')"`]);
  write(repo, "a.txt", "two\n");
  collectContext(repo, resolveTarget(repo, { scope: "working-tree", base: null }));
  assert.equal(fs.existsSync(marker), false);
});

test("getRepoRoot works from a subdirectory and rejects non-repos", (t) => {
  const repo = makeRepo({ "sub/a.txt": "x\n" });
  t.after(() => cleanup(repo));
  assert.equal(getRepoRoot(path.join(repo, "sub")), path.resolve(repo));
  assert.throws(() => getRepoRoot(path.parse(repo).root), /inside a Git repository/);
});
