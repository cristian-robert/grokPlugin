// @ts-check
// Stand-in for the grok CLI, invoked as `fake-grok.mjs <mode> <argvOut|-> ...grokArgs`.
// The runner passes only an allowlisted environment, so the mode travels as arguments. The
// received argv, prompt, and environment are recorded to argvOut so tests can assert on them.
import fs from "node:fs";
import path from "node:path";

const [mode, argvOut, ...args] = process.argv.slice(2);

if (args[0] === "models") {
  process.stdout.write(
    mode === "logged-out"
      ? "You are not authenticated.\n\nDefault model: grok-4.6\n\nAvailable models:\n  * grok-4.6 (default)\n"
      : "You are logged in with grok.com.\n\nDefault model: grok-4.7\n\nAvailable models:\n  * grok-4.7 (default)\n  - grok-4.7-build-fast\n  - grok-4.6\n"
  );
  process.exit(0);
}

if (args[0] === "inspect") {
  const leaky = mode === "leaky";
  process.stdout.write(
    JSON.stringify({
      projectInstructions: [{ path: "AGENTS.md", disabled: false }, { path: "~/.claude/CLAUDE.md", disabled: true }],
      hooks: leaky ? [{ target: "/home/u/.claude/plugins/codex/hooks/hooks.json" }] : [],
      plugins: leaky ? [{ name: "codex", enabled: true }] : [{ name: "off-plugin", enabled: false }],
      mcpServers: [{ name: "railway", disabled: true }],
      lspServers: []
    })
  );
  process.exit(0);
}

if (mode === "sandbox-fail" && args.includes("--sandbox")) {
  process.stderr.write("error: sandbox profile resolve failed: socket deny resolution failed: could not resolve runtime-socket deny path /run/podman/podman.sock: Permission denied (os error 13)\nerror: this sandbox could not enforce its deny list on Linux. Refusing to start with denied paths unprotected.\n");
  process.exit(1);
}

const isFormatStep = args.includes("--json-schema");

// Flaky modes fail only on the first call of a step; the call count lives next to argvOut.
/** @param {string} step */
function firstCall(step) {
  const counter = `${argvOut}.${step}.count`;
  const count = fs.existsSync(counter) ? Number(fs.readFileSync(counter, "utf8")) : 0;
  fs.writeFileSync(counter, String(count + 1));
  return count === 0;
}
if (mode === "write-then-fail" && !isFormatStep) {
  fs.writeFileSync(path.join(args[args.indexOf("--cwd") + 1], "edited-meanwhile.txt"), "user edit");
  process.stderr.write("boom");
  process.exit(1);
}
if (mode === "flaky-investigation" && !isFormatStep && firstCall("investigation")) {
  process.stderr.write("grok crashed: the executable was replaced");
  process.exit(1);
}
if (mode === "flaky-format" && isFormatStep && firstCall("format")) {
  process.stdout.write(JSON.stringify({ stopReason: "end_turn", structuredOutput: { verdict: "lgtm" } }));
  process.exit(0);
}
if (argvOut !== "-") {
  const promptFile = args[args.indexOf("--prompt-file") + 1];
  fs.writeFileSync(isFormatStep ? `${argvOut}.format` : argvOut, JSON.stringify({ args, prompt: fs.readFileSync(promptFile, "utf8"), env: process.env }));
}

const review = {
  verdict: "needs-attention",
  summary: "Do not ship: division by zero.",
  findings: [
    { severity: "high", title: "Unchecked divisor", body: "b can be 0.", file: "a.py", line_start: 2, line_end: 2, confidence: 0.9, recommendation: "Guard b == 0." }
  ],
  next_steps: ["Add a zero check."]
};

if (!isFormatStep) {
  if (mode === "write") {
    const cwd = args[args.indexOf("--cwd") + 1];
    fs.writeFileSync(path.join(cwd, "pwned.txt"), "grok wrote this");
  }
  if (mode === "exit1") {
    process.stderr.write("boom");
    process.exit(1);
  }
  if (mode === "garbage") {
    process.stdout.write("not json");
    process.exit(0);
  }
  if (mode === "max-turns") {
    process.stdout.write(JSON.stringify({ stopReason: "max_turns", sessionId: "sess-123", text: "partial" }));
    process.exit(0);
  }
  process.stdout.write(JSON.stringify({ stopReason: "end_turn", sessionId: "sess-123", text: "VERDICT: needs-attention\n..." }));
  process.exit(0);
}

if (mode === "bad-schema") {
  process.stdout.write(JSON.stringify({ stopReason: "end_turn", structuredOutput: { verdict: "lgtm" } }));
  process.exit(0);
}
process.stdout.write(JSON.stringify({ stopReason: "end_turn", sessionId: "sess-123", num_turns: 1, structuredOutput: review }));
