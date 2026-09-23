// @ts-check
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { EXIT_GUARDRAIL_VIOLATION, EXIT_OK, runModels, runReview } from "../plugins/grok/scripts/grok-review.mjs";
import { cleanup, makeRepo, write } from "./helpers.mjs";

const FAKE = { command: process.execPath, prefixArgs: [fileURLToPath(new URL("./fixtures/fake-grok.mjs", import.meta.url))] };

/**
 * @param {string} repo
 * @param {string} mode
 * @param {string} [argvOut]
 */
function options(repo, mode, argvOut) {
  return {
    cwd: repo,
    platform: process.platform,
    realHome: "/real/home",
    grok: FAKE,
    env: { ...process.env, FAKE_GROK_MODE: mode, ...(argvOut ? { FAKE_GROK_ARGV_OUT: argvOut } : {}) }
  };
}

function dirtyRepo() {
  const repo = makeRepo({ "a.py": "def div(a, b):\n    return a\n" });
  write(repo, "a.py", "def div(a, b):\n    return a / b\n");
  return repo;
}

test("happy path renders the review and passes every guardrail flag", async (t) => {
  const repo = dirtyRepo();
  const argvOut = path.join(os.tmpdir(), `fake-grok-argv-${process.pid}.json`);
  t.after(() => {
    cleanup(repo);
    fs.rmSync(argvOut, { force: true });
  });

  const outcome = await runReview(["focus on", "zero division"], options(repo, "ok", argvOut));
  assert.equal(outcome.exitCode, EXIT_OK);
  assert.match(outcome.output, /NEEDS ATTENTION/);
  assert.match(outcome.output, /\[HIGH\] Unchecked divisor/);
  assert.match(outcome.output, /`a\.py:2`/);
  assert.match(outcome.output, /Integrity check:\*\* passed/);
  assert.match(outcome.output, /sess-123/);

  const seen = JSON.parse(fs.readFileSync(argvOut, "utf8"));
  const args = seen.args.join(" ");
  assert.match(args, /--permission-mode dontAsk/);
  assert.match(args, /--tools read_file,grep,list_dir/);
  assert.match(args, /--disallowed-tools [^ ]*use_tool/);
  assert.match(args, /--deny MCPTool\(\*\)/);
  assert.match(args, /--no-subagents/);
  assert.equal(seen.args.includes("--sandbox"), process.platform !== "win32");
  assert.equal(seen.env.GROK_CLAUDE_MCPS_ENABLED, "false");
  assert.match(seen.env.HOME, /grok-review-.*home$/);
  assert.notEqual(seen.env.HOME, os.homedir());
  assert.ok(!fs.existsSync(path.dirname(seen.env.HOME)), "isolated home is removed after the run");
  assert.match(outcome.output, /Isolation:\*\* verified: .*AGENTS\.md/);
  assert.match(seen.prompt, /User focus: focus on zero division/);
  assert.match(seen.prompt, /\+    return a \/ b/);
  assert.match(seen.prompt, /<<<REPOSITORY_DATA [0-9a-f]{24}>>>/);
});

test("a write during the run is a guardrail violation, reported before parsing", async (t) => {
  const repo = dirtyRepo();
  t.after(() => cleanup(repo));
  const outcome = await runReview([], options(repo, "write"));
  assert.equal(outcome.exitCode, EXIT_GUARDRAIL_VIOLATION);
  assert.match(outcome.output, /GUARDRAIL VIOLATION/);
  assert.match(outcome.output, /`pwned\.txt`/);
  assert.doesNotMatch(outcome.output, /Unchecked divisor/);
  assert.ok(fs.existsSync(path.join(repo, "pwned.txt")), "nothing is auto-reverted");
});

test("fails closed on grok errors, garbage, and schema violations", async (t) => {
  const repo = dirtyRepo();
  t.after(() => cleanup(repo));
  await assert.rejects(runReview([], options(repo, "exit1")), /Grok exited with 1: boom/);
  await assert.rejects(runReview([], options(repo, "garbage")), /non-JSON output/);
  await assert.rejects(runReview([], options(repo, "bad-schema")), /did not match the expected format/);
});

test("refuses unknown models and logged-out accounts", async (t) => {
  const repo = dirtyRepo();
  t.after(() => cleanup(repo));
  await assert.rejects(runReview(["--model", "grok-9"], options(repo, "ok")), /not available[\s\S]*grok-4\.7-build-fast/);
  await assert.rejects(runReview([], options(repo, "logged-out")), /grok login/);
});

test("refuses to run when plugins or hooks would still load", async (t) => {
  const repo = dirtyRepo();
  t.after(() => cleanup(repo));
  await assert.rejects(runReview([], options(repo, "leaky")), /Refusing to run[\s\S]*plugin: codex[\s\S]*hook:/);
});

test("models subcommand returns parsed JSON", async (t) => {
  const repo = dirtyRepo();
  t.after(() => cleanup(repo));
  const ok = await runModels(options(repo, "ok"));
  assert.equal(ok.exitCode, EXIT_OK);
  assert.deepEqual(JSON.parse(ok.output), { loggedIn: true, defaultModel: "grok-4.7", models: ["grok-4.7", "grok-4.7-build-fast", "grok-4.6"] });
  const out = await runModels(options(repo, "logged-out"));
  assert.equal(out.exitCode, 1);
  assert.match(JSON.parse(out.output).error, /grok login/);
});
