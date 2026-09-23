// @ts-check
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

import { computeFingerprint, diffFingerprints } from "../plugins/grok/scripts/lib/fingerprint.mjs";
import { cleanup, git, makeRepo, write } from "./helpers.mjs";

/**
 * @param {(repo: string) => void} setup
 * @param {(repo: string) => void} mutate
 */
function changesAfter(setup, mutate) {
  const repo = makeRepo({ "a.txt": "one\n", "b.txt": "bee\n", ".gitignore": "ignored/\n" });
  try {
    setup(repo);
    const before = computeFingerprint(repo);
    mutate(repo);
    return diffFingerprints(before, computeFingerprint(repo));
  } finally {
    cleanup(repo);
  }
}

const noop = () => {};

test("stable when nothing changes, including CRLF content", () => {
  assert.deepEqual(
    changesAfter((repo) => write(repo, "crlf.txt", "a\r\nb\r\n"), noop),
    []
  );
});

test("detects modifying a clean tracked file", () => {
  assert.deepEqual(changesAfter(noop, (repo) => write(repo, "a.txt", "changed\n")), ["a.txt"]);
});

test("detects further modification of an already-dirty file", () => {
  assert.deepEqual(
    changesAfter(
      (repo) => write(repo, "a.txt", "dirty\n"),
      (repo) => write(repo, "a.txt", "dirtier\n")
    ),
    ["a.txt"]
  );
});

test("detects creating, and deleting files", () => {
  assert.deepEqual(changesAfter(noop, (repo) => write(repo, "new.txt", "x")), ["new.txt"]);
  assert.deepEqual(changesAfter(noop, (repo) => fs.rmSync(path.join(repo, "b.txt"))), ["b.txt"]);
});

test("detects staging, committing and stashing", () => {
  assert.ok(
    changesAfter(
      (repo) => write(repo, "a.txt", "dirty\n"),
      (repo) => git(repo, ["add", "a.txt"])
    ).includes("@index")
  );
  assert.ok(changesAfter(noop, (repo) => git(repo, ["commit", "-q", "--allow-empty", "-m", "x"])).includes("@HEAD"));
  assert.ok(
    changesAfter(
      (repo) => write(repo, "a.txt", "dirty\n"),
      (repo) => git(repo, ["stash", "-q"])
    ).includes("@refs")
  );
});

test("detects creating and modifying ignored files", () => {
  assert.deepEqual(changesAfter(noop, (repo) => write(repo, "ignored/secret.txt", "x")), ["@ignored:ignored/secret.txt"]);
  assert.deepEqual(
    changesAfter(
      (repo) => write(repo, "ignored/lib.js", "ok"),
      (repo) => write(repo, "ignored/lib.js", "evil payload")
    ),
    ["@ignored:ignored/lib.js"]
  );
});

test("detects git internals: hooks, config, and branch switches", () => {
  assert.deepEqual(changesAfter(noop, (repo) => write(repo, ".git/hooks/pre-commit", "#!/bin/sh\nevil\n")), ["@git:hooks/pre-commit"]);
  assert.deepEqual(changesAfter(noop, (repo) => git(repo, ["config", "core.fsmonitor", "evil"])), ["@git:config"]);
  assert.deepEqual(changesAfter(noop, (repo) => git(repo, ["switch", "-q", "-c", "other"])).sort(), ["@git:HEAD", "@refs"]);
  assert.deepEqual(changesAfter(noop, (repo) => write(repo, ".git/info/exclude", "*.py\n")), ["@git:info/exclude"]);
});

test("a planted core.fsmonitor never executes during fingerprinting", (t) => {
  const repo = makeRepo();
  t.after(() => cleanup(repo));
  const marker = path.join(repo, "pwned");
  write(repo, "fsmon.js", `require("fs").writeFileSync(${JSON.stringify(marker)}, "x")`);
  git(repo, ["config", "core.fsmonitor", `node ${path.join(repo, "fsmon.js").replace(/\\/g, "/")}`]);
  computeFingerprint(repo);
  assert.equal(fs.existsSync(marker), false);
});

test("detects edits to skip-worktree and assume-unchanged files", () => {
  assert.deepEqual(
    changesAfter(
      (repo) => git(repo, ["update-index", "--skip-worktree", "a.txt"]),
      (repo) => write(repo, "a.txt", "hidden edit\n")
    ),
    ["@flagged:a.txt"]
  );
  assert.deepEqual(
    changesAfter(
      (repo) => git(repo, ["update-index", "--assume-unchanged", "b.txt"]),
      (repo) => write(repo, "b.txt", "hidden edit\n")
    ),
    ["@flagged:b.txt"]
  );
});

test("detects changes inside a submodule even with ignore = all", (t) => {
  const inner = makeRepo({ "lib.txt": "lib\n" });
  const repo = makeRepo();
  t.after(() => {
    cleanup(inner);
    cleanup(repo);
  });
  git(repo, ["-c", "protocol.file.allow=always", "submodule", "add", "-q", inner, "sub"]);
  git(repo, ["config", "-f", ".gitmodules", "submodule.sub.ignore", "all"]);
  git(repo, ["add", "-A"]);
  git(repo, ["commit", "-q", "-m", "add sub"]);

  const before = computeFingerprint(repo);
  write(repo, "sub/lib.txt", "tampered\n");
  write(repo, ".git/modules/sub/hooks/post-checkout", "evil");
  const changed = diffFingerprints(before, computeFingerprint(repo));
  assert.ok(changed.includes("@sub:sub/lib.txt"), changed.join(", "));
  assert.ok(changed.includes("@git:modules/sub/hooks/post-checkout"), changed.join(", "));
});
