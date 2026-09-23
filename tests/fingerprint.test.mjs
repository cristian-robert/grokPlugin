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

test("detects new ignored entries by path", () => {
  assert.deepEqual(changesAfter(noop, (repo) => write(repo, "ignored/secret.txt", "x")), ["@ignored"]);
});
