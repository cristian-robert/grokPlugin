---
description: Deep adversarial code review by Grok (strictly read-only; it cannot modify your code)
argument-hint: '[--wait|--background] [--base <ref>] [--scope auto|working-tree|branch] [--model <id>] [--effort <level>] [focus ...]'
disable-model-invocation: true
allowed-tools: Bash(node:*) Bash(git:*) AskUserQuestion
disallowed-tools: Edit Write NotebookEdit
---

Run a deep adversarial review of the current changes with Grok through the plugin runtime.
It challenges the implementation approach, design choices, tradeoffs, and assumptions, and hunts for the failures that would hurt most in production.

Raw slash-command arguments:
`$ARGUMENTS`

## Core constraints

- This command is review-only. Do not fix issues, apply patches, edit files, or suggest you are about to make changes, even if the review finds serious problems.
- Your only job is to run the review and return its output verbatim.
- Do not weaken the adversarial framing or rewrite the user's focus text.

## Shell safety

When you put the raw arguments on a command line, wrap them in single quotes and replace every `'` inside them with `'\''`. This keeps the shell from expanding `$`, backticks, or globs in the user's focus text. Refer to that single-quoted string as ARGS below.

## Step 1: Model

- If the raw arguments already contain `--model`, skip this step.
- Otherwise run:

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/grok-review.mjs" models
```

- It prints JSON. If it has an `error` field, show that error to the user and stop. If the error is about logging in, tell the user to run `! grok login` and retry.
- Otherwise you have `defaultModel` and `models`. If `models` has only one entry, use it without asking.

## Step 2: Run mode

- If the raw arguments include `--wait` or `--background`, the user already chose. Do not ask.
- Otherwise estimate the review size:
  - Working-tree review: `git status --short --untracked-files=all`, `git diff --shortstat --cached`, and `git diff --shortstat`.
  - Branch review (`--base <ref>` or `--scope branch`): `git diff --shortstat <base>...HEAD`.
  - Untracked files count as reviewable work.
  - Recommend waiting only when the change is clearly tiny (roughly 1-2 files). In every other case, including unclear size, recommend background.

## Step 3: Ask once

Use `AskUserQuestion` exactly once, including only the questions that are still open:

- **Model** (header `Model`): up to 4 options from `models`, with `defaultModel` first and its label suffixed with ` (Recommended)`. The user can type any other available model through "Other".
- **Run mode** (header `Run mode`): `Wait for results` and `Run in background`, with the recommended one first and suffixed with ` (Recommended)`.

If neither question is open, do not call `AskUserQuestion`.

## Step 4: Run

Build the command, appending `--model <chosen>` only if you asked about the model (use the label without the ` (Recommended)` suffix):

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/grok-review.mjs" review ARGS --model <chosen>
```

- **Foreground:** run it with `Bash` and `timeout: 600000`. Return stdout verbatim, exactly as-is, with no commentary before or after.
- **Background:** run it with `Bash` and `run_in_background: true`, description `Grok adversarial review`. Tell the user: "Grok adversarial review started in the background. I'll show the results when it finishes." When the task completes, return its output verbatim.

## Output rules

- Return the script's stdout verbatim. Do not paraphrase, summarize, re-rank, or add commentary.
- Exit code 3 means `GUARDRAIL VIOLATION`: the repository changed while Grok was reviewing. Return the output verbatim. Do not revert, clean up, or "fix" anything. The user decides what to do.
- Exit code 1 means the review failed. Show the error message as-is.
- Never fix any issue mentioned in the review output.
