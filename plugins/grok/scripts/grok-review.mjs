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
  DEFAULT_EFFORT,
  describeSandbox,
  findGrokBinary,
  inspectIsolation,
  listModels,
  parseInvestigation,
  parseReviewOutput,
  resolveGrokHome,
  sandboxStartupFailure,
  runProcess,
  sandboxWritableDirs
} from "./lib/grok.mjs";
import { fillTemplate, renderChangesDuringReview, renderReview, validateReview, wrapUntrusted } from "./lib/review.mjs";

const PLUGIN_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
export const EXIT_OK = 0;
export const EXIT_ERROR = 1;
const FORMAT_RESERVE_MS = 2 * 60_000;

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
 * @param {{ blocking: string[], instructions: string[] }} isolation
 */
function describeIsolation(isolation) {
  const parts = [];
  if (isolation.blocking.length > 0) {
    parts.push(`WARNING: Grok loaded ${isolation.blocking.join(", ")}. Its tools can't call them and it was told not to use them, but plugin hooks may still run`);
  }
  if (isolation.instructions.length > 0) {
    parts.push(`WARNING: this repo supplied instructions Grok loaded, which could bias the review: ${isolation.instructions.join(", ")}`);
  }
  return parts.length > 0 ? parts.join(". ") : "verified: no plugins, hooks, MCP servers, or instruction files loaded";
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
          // A deep review of even a one-file change takes several minutes.
          recommendedMode: "background"
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
    // Reported, not blocking: Grok's tool allowlist already excludes MCP and plugin tools, and
    // the prompt tells it not to use them. The header shows what was loaded.
    const isolation = inspectIsolation(grok, env, root);

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
    let sandbox = describeSandbox(options.platform, os.release(), root, sandboxWritableDirs(grokHome));
    const promptFile = path.join(tempDir, "prompt.md");
    fs.writeFileSync(promptFile, prompt);

    const secretRules = buildSecretDenyRules({ repoRoot: root, realHome: options.realHome, grokHome, platform: options.platform });
    const extraDenyRules = secretRules.rules;
    const snapshot = () => new Map([...computeFingerprint(root), ...computeGrokHomeFingerprint(grokHome)]);
    const totalMs = options.timeoutMs ?? args.timeoutMinutes * 60_000;
    const deadline = Date.now() + totalMs;
    const formatReserveMs = Math.min(FORMAT_RESERVE_MS, Math.floor(totalMs / 2));
    const common = { model, effort: args.effort ?? DEFAULT_EFFORT, sandbox: sandbox.requested, cwd: root, extraDenyRules };

    const before = snapshot();
    // Step 1: investigate with tools and write a free-form review. Step 2: resume the same session
    // to convert it to the schema. --json-schema on step 1 makes Grok skip its tools entirely.
    const remaining = () => deadline - Date.now();
    /**
     * @param {{ promptFile: string, schemaJson?: string, resumeSessionId?: string }} step
     * @param {number} timeoutMs
     */
    const runStep = (step, timeoutMs) =>
      runProcess(grok.command, [...grok.prefixArgs, ...buildReviewArgs({ ...common, ...step })], { env, cwd: root, timeoutMs });

    /** @type {unknown} */
    let failure = null;
    /** @type {import("./lib/review.mjs").Review | null} */
    let review = null;
    /** @type {string | null} */
    let sessionId = null;
    try {
      let investigationRun = await runStep({ promptFile }, totalMs - formatReserveMs);
      // Grok's sandbox can refuse to start on some machines. As with Windows (no sandbox at all),
      // the review then runs on the remaining layers and the header says the sandbox was not in effect.
      const sandboxFailure = sandbox.requested ? sandboxStartupFailure(investigationRun) : null;
      if (sandboxFailure) {
        sandbox = { requested: false, enforced: "no", detail: `NOT enforced: Grok couldn't start its sandbox on this machine (${sandboxFailure})` };
        common.sandbox = false;
        investigationRun = await runStep({ promptFile }, Math.max(remaining() - formatReserveMs, 60_000));
      }
      // One retry per step for transient failures (a crash, or grok's binary being replaced
      // mid-run), but never after a timeout and only while the time budget allows it.
      let investigation;
      try {
        investigation = parseInvestigation(investigationRun);
      } catch (error) {
        if (investigationRun.timedOut || remaining() < formatReserveMs + 2 * 60_000) {
          throw error;
        }
        investigationRun = await runStep({ promptFile }, remaining() - formatReserveMs);
        investigation = parseInvestigation(investigationRun);
      }

      const formatPromptFile = path.join(tempDir, "format.md");
      fs.copyFileSync(path.join(PLUGIN_ROOT, "prompts", "format-review.md"), formatPromptFile);
      const formatStep = { promptFile: formatPromptFile, schemaJson, resumeSessionId: investigation.sessionId };
      const parseFormatted = (/** @type {import("./lib/grok.mjs").RunResult} */ run) => {
        const parsed = parseReviewOutput(run);
        const problems = validateReview(parsed.review);
        if (problems.length > 0) {
          throw new Error(`Grok's review did not match the expected format: ${problems.join("; ")}`);
        }
        return { review: /** @type {import("./lib/review.mjs").Review} */ (parsed.review), sessionId: parsed.sessionId };
      };
      let formatRun = await runStep(formatStep, Math.max(remaining(), 30_000));
      let formatted;
      try {
        formatted = parseFormatted(formatRun);
      } catch (error) {
        if (formatRun.timedOut || remaining() < 60_000) {
          throw error;
        }
        formatRun = await runStep(formatStep, remaining());
        formatted = parseFormatted(formatRun);
      }
      review = formatted.review;
      sessionId = formatted.sessionId;
    } catch (error) {
      failure = error;
    }

    // Changes made while Grok ran are reported, never fatal: they are almost always the user's own
    // edits. The check runs even when Grok failed, so the report is never lost.
    /** @type {string[]} */
    let changed;
    try {
      changed = diffFingerprints(before, snapshot());
    } catch (error) {
      changed = [`(the repository could not be re-checked after the review: ${/** @type {Error} */ (error).message})`];
    }
    if (failure || !review) {
      const reason = failure instanceof Error ? failure.message : "Grok did not produce a review.";
      throw new Error(changed.length > 0 ? `${reason}\n\n${renderChangesDuringReview(changed, { afterFailure: true })}` : reason);
    }
    return {
      exitCode: EXIT_OK,
      output: renderReview(review, {
        model,
        target: `${target.label} (${context.summary})`,
        sandbox: sandbox.detail,
        integrity: (changed.length > 0 ? `${changed.length} change(s), listed at the end of this report` : "none") +
          (before.has(IGNORED_TRUNCATED_KEY) ? " (too many ignored files to compare them all; only the first 200000 were checked)" : ""),
        changedDuringReview: changed,
        isolation: describeIsolation(isolation) +
          (secretRules.skipped.length > 0 ? `. Note: these paths contain characters Grok's permission rules can't express, so Grok's reads there aren't blocked: ${secretRules.skipped.join(", ")}` : ""),
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
      outcome = { exitCode: EXIT_ERROR, output: `# Grok review failed\n\n**Reason:** ${/** @type {Error} */ (error).message}` };
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
