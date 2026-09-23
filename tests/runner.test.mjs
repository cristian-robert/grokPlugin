// @ts-check
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { EXIT_OK, runPrepare, runReview } from "../plugins/grok/scripts/grok-review.mjs";
import { cleanup, makeRepo, write } from "./helpers.mjs";

const FAKE_SCRIPT = fileURLToPath(new URL("./fixtures/fake-grok.mjs", import.meta.url));

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
    grok: { command: process.execPath, prefixArgs: [FAKE_SCRIPT, mode, argvOut ?? "-"] },
    env: { ...process.env, AWS_SECRET_ACCESS_KEY: "leak-me", GROK_FOLDER_TRUST: "0" }
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
    fs.rmSync(`${argvOut}.format`, { force: true });
  });

  const outcome = await runReview(["focus on", "zero division"], options(repo, "ok", argvOut));
  assert.equal(outcome.exitCode, EXIT_OK);
  assert.match(outcome.output, /NEEDS ATTENTION/);
  assert.match(outcome.output, /\[HIGH\] Unchecked divisor/);
  assert.match(outcome.output, /`a\.py:2`/);
  assert.match(outcome.output, /Changes during review:\*\* none/);
  assert.doesNotMatch(outcome.output, /Changed while the review was running/);
  assert.match(outcome.output, /sess-123/);

  const seen = JSON.parse(fs.readFileSync(argvOut, "utf8"));
  const args = seen.args.join(" ");
  assert.doesNotMatch(args, /--json-schema/, "the investigation step must not be schema-constrained");
  assert.match(args, /--output-format json/);
  const format = JSON.parse(fs.readFileSync(`${argvOut}.format`, "utf8"));
  const formatArgs = format.args.join(" ");
  assert.match(formatArgs, /--resume sess-123/);
  assert.match(formatArgs, /--json-schema /);
  assert.match(formatArgs, /--tools read_file,grep,list_dir/, "the format step keeps every guardrail flag");
  assert.match(formatArgs, /--deny MCPTool\(\*\)/);
  assert.match(format.prompt, /Convert the review you just wrote into JSON/);
  assert.match(args, /--permission-mode dontAsk/);
  assert.match(args, /--tools read_file,grep,list_dir/);
  assert.match(args, /--disallowed-tools [^ ]*use_tool/);
  assert.match(args, /--deny MCPTool\(\*\)/);
  assert.match(args, /--no-subagents/);
  assert.match(args, /--reasoning-effort high/);
  assert.doesNotMatch(args, /--max-turns/);
  assert.equal(seen.args.includes("--sandbox"), process.platform !== "win32");
  assert.equal(seen.env.GROK_CLAUDE_MCPS_ENABLED, "false");
  assert.equal(seen.env.AWS_SECRET_ACCESS_KEY, undefined, "credentials never reach grok");
  assert.equal(seen.env.GROK_FOLDER_TRUST, undefined, "inherited GROK_* overrides are dropped");
  assert.match(args, /--deny Read\([^)]*\.ssh\/\*\*\)/);
  assert.match(seen.env.HOME, /grok-review-.*home$/);
  assert.notEqual(seen.env.HOME, os.homedir());
  assert.ok(!fs.existsSync(path.dirname(seen.env.HOME)), "isolated home is removed after the run");
  assert.match(outcome.output, /Isolation:\*\* WARNING: this repo supplied instructions.*AGENTS\.md/);
  assert.match(seen.prompt, /User focus: focus on zero division/);
  assert.match(seen.prompt, /Phase 3: Trace beyond the diff/);
  assert.match(seen.prompt, /Do not use MCP servers, plugins/);
  assert.match(seen.prompt, /## Diff Stat[\s\S]*a\.py/);
  assert.match(seen.prompt, /\+    return a \/ b/);
  assert.match(seen.prompt, /<<<REPOSITORY_DATA [0-9a-f]{24}>>>/);
});

test("files changed during the run are listed, and the review is still returned", async (t) => {
  const repo = dirtyRepo();
  t.after(() => cleanup(repo));
  const outcome = await runReview([], options(repo, "write"));
  assert.equal(outcome.exitCode, EXIT_OK);
  assert.match(outcome.output, /Unchecked divisor/, "the review is kept");
  assert.match(outcome.output, /Changes during review:\*\* 1 change\(s\), listed at the end/);
  assert.match(outcome.output, /## Changed while the review was running \(1\)[\s\S]*"pwned\.txt"/);
  assert.ok(fs.existsSync(path.join(repo, "pwned.txt")), "nothing is reverted");
});

test("fails closed on grok errors, garbage, and schema violations", async (t) => {
  const repo = dirtyRepo();
  t.after(() => cleanup(repo));
  await assert.rejects(runReview([], options(repo, "exit1")), /Grok exited with 1: boom/);
  await assert.rejects(runReview([], options(repo, "garbage")), /non-JSON output/);
  await assert.rejects(runReview([], options(repo, "bad-schema")), /did not match the expected format/);
  await assert.rejects(runReview([], options(repo, "max-turns")), /stopped before finishing[\s\S]*max_turns/);
});

test("refuses unknown models and logged-out accounts", async (t) => {
  const repo = dirtyRepo();
  t.after(() => cleanup(repo));
  await assert.rejects(runReview(["--model", "grok-9"], options(repo, "ok")), /not available[\s\S]*grok-4\.7-build-fast/);
  await assert.rejects(runReview([], options(repo, "logged-out")), /grok login/);
});

test("loaded plugins and hooks are reported in the header, not blocking", async (t) => {
  const repo = dirtyRepo();
  t.after(() => cleanup(repo));
  const outcome = await runReview([], options(repo, "leaky"));
  assert.equal(outcome.exitCode, EXIT_OK);
  assert.match(outcome.output, /Isolation:\*\* WARNING: Grok loaded plugin: codex, hook: .*hooks\.json/);
});

test("prepare returns models and review size without touching git write paths", async (t) => {
  const repo = dirtyRepo();
  t.after(() => cleanup(repo));
  const ok = await runPrepare([], options(repo, "ok"));
  assert.equal(ok.exitCode, EXIT_OK);
  assert.deepEqual(JSON.parse(ok.output), {
    loggedIn: true,
    defaultModel: "grok-4.7",
    models: ["grok-4.7", "grok-4.7-build-fast", "grok-4.6"],
    target: "working tree diff",
    summary: "0 staged, 1 unstaged, 0 untracked file(s).",
    fileCount: 1,
    recommendedMode: "background"
  });
  const out = await runPrepare([], options(repo, "logged-out"));
  assert.equal(out.exitCode, 1);
  assert.match(JSON.parse(out.output).error, /grok login/);
  const clean = makeRepo();
  t.after(() => cleanup(clean));
  assert.match(JSON.parse((await runPrepare(["--scope", "working-tree"], options(clean, "ok"))).output).error, /Nothing to review/);
});

test("uses the account's default model when --model is absent", async (t) => {
  const repo = dirtyRepo();
  const argvOut = path.join(os.tmpdir(), `fake-grok-argv-default-${process.pid}.json`);
  t.after(() => {
    cleanup(repo);
    fs.rmSync(argvOut, { force: true });
    fs.rmSync(`${argvOut}.format`, { force: true });
  });
  const outcome = await runReview([], options(repo, "ok", argvOut));
  assert.match(outcome.output, /Model:\*\* grok-4\.7/);
  const { args } = JSON.parse(fs.readFileSync(argvOut, "utf8"));
  assert.equal(args[args.indexOf("-m") + 1], "grok-4.7");
});

test("a clean repo fails fast without starting grok", async (t) => {
  const repo = makeRepo();
  t.after(() => cleanup(repo));
  const missing = { command: path.join(repo, "no-such-grok"), prefixArgs: [] };
  await assert.rejects(runReview(["--scope", "working-tree"], { ...options(repo, "ok"), grok: missing }), /Nothing to review/);
});
