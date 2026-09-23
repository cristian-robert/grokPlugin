// @ts-check
// Runs the REAL grok CLI (installed, but not logged in) against every argument shape the plugin
// generates for this platform. grok validates arguments before it checks authentication, so a
// "Not signed in" error proves the arguments parsed. Run in CI after installing grok:
//   node --test tests/smoke/grok-cli.smoke.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

import { buildGrokEnv, buildReviewArgs, buildSecretDenyRules, findGrokBinary, parseModelsOutput, resolveGrokHome } from "../../plugins/grok/scripts/lib/grok.mjs";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const SCHEMA = fs.readFileSync(path.join(REPO, "plugins", "grok", "schemas", "review-output.schema.json"), "utf8");
const realHome = os.homedir();
const grokHome = resolveGrokHome(process.env, realHome);
const grok = findGrokBinary(process.env, process.platform);

/** @param {string[]} args @param {NodeJS.ProcessEnv} env */
function spawnGrok(args, env) {
  return spawnSync(grok, args, { cwd: REPO, env, encoding: "utf8", shell: false, windowsHide: true, timeout: 60_000 });
}

/** @param {string[]} args @param {NodeJS.ProcessEnv} env */
function run(args, env) {
  const result = spawnGrok(args, env);
  return `${result.stdout}\n${result.stderr}`;
}

/** @param {NodeJS.ProcessEnv} env */
function inspect(env) {
  const result = spawnGrok(["inspect", "--json"], env);
  try {
    return /** @type {{ projectInstructions?: { path: string }[] }} */ (JSON.parse(result.stdout));
  } catch {
    throw new Error(`grok inspect --json did not return JSON:\n${result.stdout}\n${result.stderr}`);
  }
}

/** Isolated env exactly as the plugin builds it, plus a temp prompt file. */
function setup() {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), "grok-smoke-"));
  const isolatedHome = path.join(temp, "home");
  fs.mkdirSync(isolatedHome);
  const promptFile = path.join(temp, "prompt.md");
  fs.writeFileSync(promptFile, "Reply OK.");
  const env = buildGrokEnv(process.env, { isolatedHome, grokHome, platform: process.platform });
  return { temp, env, promptFile };
}

test(`findGrokBinary resolves an absolute executable (${grok})`, () => {
  assert.ok(path.isAbsolute(grok));
  if (process.platform === "win32") {
    assert.match(grok, /\.exe$/i);
  }
});

test("every generated argument parses: investigation step", (t) => {
  const { temp, env, promptFile } = setup();
  t.after(() => fs.rmSync(temp, { recursive: true, force: true }));
  const { rules, skipped } = buildSecretDenyRules({ repoRoot: REPO, realHome, grokHome, platform: process.platform });
  console.log(`deny rules: ${rules.length}, skipped: ${skipped.join(" | ") || "none"}`);
  const args = buildReviewArgs({ promptFile, model: "grok-4.7", effort: "high", sandbox: process.platform !== "win32", cwd: REPO, extraDenyRules: rules });
  const output = run(args, env);
  assert.match(output, /Not signed in/, `grok rejected the arguments:\n${output}`);
});

test("every generated argument parses: format step with --resume and --json-schema", (t) => {
  const { temp, env, promptFile } = setup();
  t.after(() => fs.rmSync(temp, { recursive: true, force: true }));
  const { rules } = buildSecretDenyRules({ repoRoot: REPO, realHome, grokHome, platform: process.platform });
  const args = buildReviewArgs({
    promptFile, model: "grok-4.7", effort: "high", sandbox: process.platform !== "win32", cwd: REPO, extraDenyRules: rules,
    schemaJson: JSON.stringify(JSON.parse(SCHEMA)), resumeSessionId: "01a0d080-2662-7f32-9f2d-8a6edc7ded3a"
  });
  const output = run(args, env);
  assert.doesNotMatch(output, /malformed|unexpected argument|invalid value/i, output);
});

test("grok models output parses when logged out", (t) => {
  const { temp, env } = setup();
  t.after(() => fs.rmSync(temp, { recursive: true, force: true }));
  const list = parseModelsOutput(run(["models"], env));
  assert.equal(list.loggedIn, false);
  assert.ok(list.models.length > 0, "the fallback model list is parsed");
});

test("the isolated HOME hides Claude config from grok on this platform", (t) => {
  // Plant a Claude instruction file in the REAL home (CI only), then check grok can't see it.
  const marker = path.join(realHome, ".claude", "CLAUDE.md");
  const planted = Boolean(process.env.CI) && !fs.existsSync(marker);
  if (planted) {
    fs.mkdirSync(path.dirname(marker), { recursive: true });
    fs.writeFileSync(marker, "smoke-test marker\n");
  }
  const { temp, env } = setup();
  t.after(() => {
    fs.rmSync(temp, { recursive: true, force: true });
    if (planted) {
      fs.rmSync(marker, { force: true });
    }
  });
  const baseline = inspect({ ...env, HOME: realHome, USERPROFILE: realHome });
  const isolated = inspect(env);
  const paths = (/** @type {{ projectInstructions?: { path: string }[] }} */ data) => (data.projectInstructions ?? []).map((entry) => entry.path);
  console.log(`baseline instructions: ${paths(baseline).join(", ") || "none"}; isolated: ${paths(isolated).join(", ") || "none"}`);
  if (fs.existsSync(marker)) {
    assert.ok(paths(baseline).some((p) => /\.claude/i.test(p)), "sanity: grok finds ~/.claude/CLAUDE.md with the real home");
  }
  assert.ok(!paths(isolated).some((p) => p.toLowerCase().startsWith(realHome.toLowerCase())), `grok still reads the real home despite the isolated HOME/USERPROFILE: ${paths(isolated).join(", ")}`);
});
