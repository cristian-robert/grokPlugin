#!/usr/bin/env node
// @ts-check
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { parseReviewArgs } from "./lib/args.mjs";
import { collectContext, getRepoRoot, resolveTarget } from "./lib/git.mjs";
import { IGNORED_TRUNCATED_KEY, computeFingerprint, computeGrokHomeFingerprint, diffFingerprints } from "./lib/fingerprint.mjs";
import {
  buildGrokEnv,
  buildReviewArgs,
  buildSecretDenyRules,
  describeSandbox,
  findGrokBinary,
  inspectIsolation,
  listModels,
  parseReviewOutput,
  resolveGrokHome,
  runProcess,
  sandboxWritableDirs
} from "./lib/grok.mjs";
import { fillTemplate, renderReview, renderViolation, validateReview, wrapUntrusted } from "./lib/review.mjs";

const PLUGIN_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
export const EXIT_OK = 0;
export const EXIT_ERROR = 1;
export const EXIT_GUARDRAIL_VIOLATION = 3;

/**
 * @typedef {import("./lib/grok.mjs").GrokCommand} GrokCommand
 * @typedef {{ cwd: string, env: NodeJS.ProcessEnv, platform: NodeJS.Platform, realHome: string, grok?: GrokCommand, timeoutMs?: number }} RunOptions
 * @typedef {{ exitCode: number, output: string }} Outcome
 */

/**
 * @param {RunOptions} options
 * @returns {GrokCommand}
 */
function resolveGrok(options) {
  return options.grok ?? { command: findGrokBinary(options.env, options.platform), prefixArgs: [] };
}

/**
 * Runs `fn` with a throwaway directory holding an empty isolated HOME, removed afterwards.
 * @template T
 * @param {RunOptions} options
 * @param {(ctx: { tempDir: string, env: NodeJS.ProcessEnv, grokHome: string }) => Promise<T>} fn
 * @returns {Promise<T>}
 */
async function withIsolation(options, fn) {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "grok-review-"));
  const isolatedHome = path.join(tempDir, "home");
  fs.mkdirSync(isolatedHome);
  const grokHome = resolveGrokHome(options.env, options.realHome);
  const removeTemp = () => fs.rmSync(tempDir, { recursive: true, force: true });
  // Also clean up if the process is terminated mid-review and `finally` never runs.
  process.once("exit", removeTemp);
  try {
    return await fn({ tempDir, grokHome, env: buildGrokEnv(options.env, { isolatedHome, grokHome, platform: options.platform }) });
  } finally {
    process.removeListener("exit", removeTemp);
    removeTemp();
  }
}

/**
 * Everything the slash command needs before asking the user anything: the account's models and
 * the size of the review target. Doing this in the script means the command never needs to
 * pre-approve raw `git` commands, which could write files (e.g. `git diff --output=`).
 * @param {string[]} argv
 * @param {RunOptions} options
 * @returns {Promise<Outcome>}
 */
export async function runPrepare(argv, options) {
  try {
    const args = parseReviewArgs(argv);
    const root = getRepoRoot(options.cwd);
    const target = resolveTarget(root, args);
    const context = collectContext(root, target);
    const list = await withIsolation(options, async ({ env }) => listModels(resolveGrok(options), env));
    const fileCount = context.changedFiles.length;
    return {
      exitCode: EXIT_OK,
      output: JSON.stringify(
        {
          ...list,
          target: target.label,
          summary: context.summary,
          fileCount,
          recommendedMode: fileCount <= 2 && !context.truncated ? "wait" : "background"
        },
        null,
        2
      )
    };
  } catch (error) {
    return { exitCode: EXIT_ERROR, output: JSON.stringify({ error: /** @type {Error} */ (error).message }, null, 2) };
  }
}

/**
 * @param {string[]} argv
 * @param {RunOptions} options
 * @returns {Promise<Outcome>}
 */
export async function runReview(argv, options) {
  const args = parseReviewArgs(argv);
  const root = getRepoRoot(options.cwd);
  // Cheap git checks first, so "Nothing to review" never waits on grok startups.
  const target = resolveTarget(root, args);
  const context = collectContext(root, target);
  const grok = resolveGrok(options);
  return withIsolation(options, async ({ tempDir, env, grokHome }) => {
    const available = listModels(grok, env);
    const model = args.model ?? available.defaultModel;
    if (!model || !available.models.includes(model)) {
      throw new Error(`Model "${model ?? "(none)"}" is not available to this Grok account. Available: ${available.models.join(", ") || "(none)"}.`);
    }
    const isolation = inspectIsolation(grok, env, root);
    if (isolation.blocking.length > 0) {
      throw new Error(`Refusing to run: Grok would still load components that could add capabilities to the reviewer:\n- ${isolation.blocking.join("\n- ")}\nDisable them for Grok (grok plugin / grok mcp) and retry.`);
    }

    const wrapped = wrapUntrusted(context.content);
    const prompt = fillTemplate(fs.readFileSync(path.join(PLUGIN_ROOT, "prompts", "adversarial-review.md"), "utf8"), {
      TARGET_LABEL: target.label,
      TARGET_SUMMARY: context.summary,
      USER_FOCUS: args.focus || "none; review the whole change",
      NONCE: wrapped.nonce,
      COLLECTION_GUIDANCE: context.truncated
        ? "The repository data was truncated to fit. Read every file under Changed Files with read_file before concluding."
        : "The repository data contains the full change. Use it as primary evidence and read surrounding code as needed.",
      REVIEW_INPUT: wrapped.text
    });
    const schemaJson = JSON.stringify(JSON.parse(fs.readFileSync(path.join(PLUGIN_ROOT, "schemas", "review-output.schema.json"), "utf8")));
    const sandbox = describeSandbox(options.platform, os.release(), root, sandboxWritableDirs(grokHome));
    const promptFile = path.join(tempDir, "prompt.md");
    fs.writeFileSync(promptFile, prompt);

    const extraDenyRules = buildSecretDenyRules({ repoRoot: root, realHome: options.realHome, grokHome, platform: options.platform });
    const snapshot = () => new Map([...computeFingerprint(root), ...computeGrokHomeFingerprint(grokHome)]);
    const before = snapshot();
    const run = await runProcess(
      grok.command,
      [...grok.prefixArgs, ...buildReviewArgs({ promptFile, model, effort: args.effort, schemaJson, sandbox: sandbox.requested, cwd: root, extraDenyRules })],
      { env, cwd: root, timeoutMs: options.timeoutMs ?? args.timeoutMinutes * 60_000 }
    );
    // The integrity check runs before any parsing so a violation can never be masked by an error.
    // If the repo is too damaged to fingerprint at all, that is itself a violation.
    /** @type {string[]} */
    let changed;
    try {
      changed = diffFingerprints(before, snapshot());
    } catch (error) {
      changed = [`(repository could not be fingerprinted after the run: ${/** @type {Error} */ (error).message})`];
    }
    if (changed.length > 0) {
      return { exitCode: EXIT_GUARDRAIL_VIOLATION, output: renderViolation(changed, sandbox.detail) };
    }

    const { review, sessionId } = parseReviewOutput(run);
    const problems = validateReview(review);
    if (problems.length > 0) {
      throw new Error(`Grok's review did not match the expected format: ${problems.join("; ")}`);
    }
    return {
      exitCode: EXIT_OK,
      output: renderReview(/** @type {import("./lib/review.mjs").Review} */ (review), {
        model,
        target: `${target.label} (${context.summary})`,
        sandbox: sandbox.detail,
        integrity: before.has(IGNORED_TRUNCATED_KEY)
          ? `passed: repository unchanged by the review (only the first 200000 of ${before.get(IGNORED_TRUNCATED_KEY)} ignored files were checked)`
          : "passed: repository unchanged by the review",
        isolation: isolation.instructions.length > 0
          ? `verified no plugins, hooks, or MCP servers. WARNING: this repo supplied instructions Grok loaded, which could bias the review: ${isolation.instructions.join(", ")}`
          : "verified: no plugins, hooks, MCP servers, or instruction files loaded",
        truncated: context.truncated,
        sessionId
      })
    };
  });
}

/** @param {string[]} argv */
async function main(argv) {
  const [subcommand, ...rest] = argv;
  /** @type {RunOptions} */
  const options = { cwd: process.cwd(), env: process.env, platform: process.platform, realHome: os.homedir() };
  /** @type {Outcome} */
  let outcome;
  if (subcommand === "prepare") {
    outcome = await runPrepare(rest, options);
  } else if (subcommand === "review") {
    try {
      outcome = await runReview(rest, options);
    } catch (error) {
      outcome = { exitCode: EXIT_ERROR, output: `Grok review failed: ${/** @type {Error} */ (error).message}` };
    }
  } else {
    outcome = { exitCode: EXIT_ERROR, output: "Usage: grok-review.mjs prepare|review [--base <ref>] [--scope auto|working-tree|branch] [--model <id>] [--effort <level>] [--timeout-minutes <n>] [focus ...]" };
  }
  process.stdout.write(`${outcome.output}\n`);
  process.exitCode = outcome.exitCode;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await main(process.argv.slice(2));
}
