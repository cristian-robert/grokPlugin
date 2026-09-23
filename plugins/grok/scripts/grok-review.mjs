#!/usr/bin/env node
// @ts-check
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { parseReviewArgs } from "./lib/args.mjs";
import { collectContext, getRepoRoot, resolveTarget } from "./lib/git.mjs";
import { computeFingerprint, diffFingerprints } from "./lib/fingerprint.mjs";
import {
  buildGrokEnv,
  buildReviewArgs,
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
  try {
    return await fn({ tempDir, grokHome, env: buildGrokEnv(options.env, { isolatedHome, grokHome, platform: options.platform }) });
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
}

/**
 * @param {RunOptions} options
 * @returns {Promise<Outcome>}
 */
export async function runModels(options) {
  try {
    const list = await withIsolation(options, async ({ env }) => listModels(resolveGrok(options), env));
    return { exitCode: EXIT_OK, output: JSON.stringify(list, null, 2) };
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
  const grok = resolveGrok(options);
  return withIsolation(options, async ({ tempDir, env, grokHome }) => {
    const available = listModels(grok, env);
    if (!available.models.includes(args.model)) {
      throw new Error(`Model "${args.model}" is not available to this Grok account. Available: ${available.models.join(", ") || "(none)"}.`);
    }
    const isolation = inspectIsolation(grok, env, root);
    if (isolation.blocking.length > 0) {
      throw new Error(`Refusing to run: Grok would still load components that could add capabilities to the reviewer:\n- ${isolation.blocking.join("\n- ")}\nDisable them for Grok (grok plugin / grok mcp) and retry.`);
    }

    const target = resolveTarget(root, args);
    const context = collectContext(root, target);
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

    const before = computeFingerprint(root);
    const run = await runProcess(
      grok.command,
      [...grok.prefixArgs, ...buildReviewArgs({ promptFile, model: args.model, effort: args.effort, schemaJson, sandbox: sandbox.requested, cwd: root })],
      { env, cwd: root, timeoutMs: options.timeoutMs }
    );
    // The integrity check runs before any parsing so a violation can never be masked by an error.
    const changed = diffFingerprints(before, computeFingerprint(root));
    if (changed.length > 0) {
      return { exitCode: EXIT_GUARDRAIL_VIOLATION, output: renderViolation(changed, sandbox.requested) };
    }

    const { review, sessionId } = parseReviewOutput(run);
    const problems = validateReview(review);
    if (problems.length > 0) {
      throw new Error(`Grok's review did not match the expected format: ${problems.join("; ")}`);
    }
    return {
      exitCode: EXIT_OK,
      output: renderReview(/** @type {import("./lib/review.mjs").Review} */ (review), {
        model: args.model,
        target: `${target.label} (${context.summary})`,
        sandbox: sandbox.detail,
        integrity: "passed: repository unchanged by the review",
        isolation: isolation.instructions.length > 0
          ? `verified: no plugins, hooks, or MCP servers loaded; repo instruction files Grok read: ${isolation.instructions.join(", ")}`
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
  if (subcommand === "models") {
    outcome = await runModels(options);
  } else if (subcommand === "review") {
    try {
      outcome = await runReview(rest, options);
    } catch (error) {
      outcome = { exitCode: EXIT_ERROR, output: `Grok review failed: ${/** @type {Error} */ (error).message}` };
    }
  } else {
    outcome = { exitCode: EXIT_ERROR, output: "Usage: grok-review.mjs models --json | review [--base <ref>] [--scope auto|working-tree|branch] [--model <id>] [--effort <level>] [focus ...]" };
  }
  process.stdout.write(`${outcome.output}\n`);
  process.exitCode = outcome.exitCode;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await main(process.argv.slice(2));
}
