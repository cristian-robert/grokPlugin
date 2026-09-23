// @ts-check
// Stand-in for the grok CLI. Behavior is chosen by FAKE_GROK_MODE; the received argv is
// recorded to FAKE_GROK_ARGV_OUT so tests can assert the guardrail flags were passed.
import fs from "node:fs";
import path from "node:path";

const args = process.argv.slice(2);
const mode = process.env.FAKE_GROK_MODE ?? "ok";

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

if (process.env.FAKE_GROK_ARGV_OUT) {
  const promptFile = args[args.indexOf("--prompt-file") + 1];
  fs.writeFileSync(
    process.env.FAKE_GROK_ARGV_OUT,
    JSON.stringify({ args, prompt: fs.readFileSync(promptFile, "utf8"), env: { GROK_CLAUDE_MCPS_ENABLED: process.env.GROK_CLAUDE_MCPS_ENABLED, HOME: process.env.HOME, GROK_HOME: process.env.GROK_HOME } })
  );
}

const review = {
  verdict: "needs-attention",
  summary: "Do not ship: division by zero.",
  findings: [
    { severity: "high", title: "Unchecked divisor", body: "b can be 0.", file: "a.py", line_start: 2, line_end: 2, confidence: 0.9, recommendation: "Guard b == 0." }
  ],
  next_steps: ["Add a zero check."]
};

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
if (mode === "bad-schema") {
  process.stdout.write(JSON.stringify({ stopReason: "end_turn", structuredOutput: { verdict: "lgtm" } }));
  process.exit(0);
}
process.stdout.write(JSON.stringify({ stopReason: "end_turn", sessionId: "sess-123", num_turns: 3, structuredOutput: review }));
