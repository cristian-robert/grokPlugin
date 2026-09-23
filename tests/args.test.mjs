// @ts-check
import { test } from "node:test";
import assert from "node:assert/strict";

import { parseReviewArgs, splitRawArgs } from "../plugins/grok/scripts/lib/args.mjs";

test("splitRawArgs handles quotes and whitespace", () => {
  assert.deepEqual(splitRawArgs(`--base main  focus on "race conditions" 'and retries'`), [
    "--base",
    "main",
    "focus",
    "on",
    "race conditions",
    "and retries"
  ]);
  assert.deepEqual(splitRawArgs(""), []);
  assert.deepEqual(splitRawArgs("   "), []);
});

test("a lone apostrophe is literal", () => {
  assert.deepEqual(splitRawArgs("don't break retries"), ["don't", "break", "retries"]);
});

test("flags appended after the raw string are parsed", () => {
  const parsed = parseReviewArgs(["--base main check auth", "--model", "grok-4.6"]);
  assert.equal(parsed.base, "main");
  assert.equal(parsed.model, "grok-4.6");
  assert.equal(parsed.focus, "check auth");
});

test("defaults", () => {
  assert.deepEqual(parseReviewArgs([]), {
    base: null,
    scope: "auto",
    model: "grok-4.7",
    effort: null,
    focus: ""
  });
});

test("a single raw $ARGUMENTS string is tokenized", () => {
  const parsed = parseReviewArgs(["--base origin/main check auth paths"]);
  assert.equal(parsed.base, "origin/main");
  assert.equal(parsed.focus, "check auth paths");
});

test("flags and focus text mix", () => {
  const parsed = parseReviewArgs(["--scope", "working-tree", "--effort", "high", "look", "at", "--model", "grok-4.6", "retries"]);
  assert.equal(parsed.scope, "working-tree");
  assert.equal(parsed.effort, "high");
  assert.equal(parsed.model, "grok-4.6");
  assert.equal(parsed.focus, "look at retries");
});

test("--wait and --background are Claude-side flags and are ignored", () => {
  const parsed = parseReviewArgs(["--background", "--wait", "focus"]);
  assert.equal(parsed.focus, "focus");
});

test("-- ends flag parsing", () => {
  const parsed = parseReviewArgs(["--", "--base", "is", "text"]);
  assert.equal(parsed.base, null);
  assert.equal(parsed.focus, "--base is text");
});

test("rejects unknown flags", () => {
  assert.throws(() => parseReviewArgs(["--write"]), /Unknown option "--write"/);
  assert.throws(() => parseReviewArgs(["--scope", "staged"]), /Unsupported scope "staged"/);
});

test("rejects missing values", () => {
  assert.throws(() => parseReviewArgs(["--base"]), /--base requires a value/);
  assert.throws(() => parseReviewArgs(["--base", "--scope"]), /--base requires a value/);
});

test("rejects refs that git could read as options", () => {
  assert.throws(() => parseReviewArgs(["--base", "-output=/tmp/x"]), /--base requires a value|Invalid git ref/);
  assert.throws(() => parseReviewArgs(["--base=--exec=evil"]), /Invalid git ref/);
});

test("--flag=value form", () => {
  const parsed = parseReviewArgs(["--base=main", "--scope=branch", "--effort=xhigh"]);
  assert.equal(parsed.base, "main");
  assert.equal(parsed.scope, "branch");
  assert.equal(parsed.effort, "xhigh");
});

test("validates model and effort", () => {
  assert.throws(() => parseReviewArgs(["--model", "grok;rm$(x)"]), /Invalid model/);
  assert.throws(() => parseReviewArgs(["--effort", "ludicrous"]), /Unsupported effort "ludicrous"/);
});
