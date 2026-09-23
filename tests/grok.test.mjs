// @ts-check
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { auditIsolation, buildGrokEnv, describeSandbox, findGrokBinary, parseModelsOutput, parseReviewOutput, resolveGrokHome } from "../plugins/grok/scripts/lib/grok.mjs";

test("parseModelsOutput: logged in", () => {
  const text = "You are logged in with grok.com.\n\nDefault model: grok-4.7\n\nAvailable models:\n  * grok-4.7 (default)\n  - grok-4.7-build-fast\n  - grok-4.6\n  - grok-4.5\n";
  assert.deepEqual(parseModelsOutput(text), { loggedIn: true, defaultModel: "grok-4.7", models: ["grok-4.7", "grok-4.7-build-fast", "grok-4.6", "grok-4.5"] });
});

test("parseModelsOutput: logged out and CRLF", () => {
  const text = "You are not authenticated.\r\n\r\nDefault model: grok-4.6\r\n\r\nAvailable models:\r\n  * grok-4.6 (default)\r\n  - grok-4.5\r\n";
  assert.deepEqual(parseModelsOutput(text), { loggedIn: false, defaultModel: "grok-4.6", models: ["grok-4.6", "grok-4.5"] });
});

test("buildGrokEnv isolates HOME and Claude/Cursor config, keeps real GROK_HOME", () => {
  const env = buildGrokEnv(
    { PATH: "/bin", HOME: "/real", GROK_SANDBOX: "off", GROK_CLAUDE_MCPS_ENABLED: "true" },
    { isolatedHome: "/tmp/iso", grokHome: "/real/.grok", platform: "darwin" }
  );
  assert.equal(env.PATH, "/bin");
  assert.equal(env.HOME, "/tmp/iso");
  assert.equal(env.GROK_HOME, "/real/.grok");
  assert.equal(env.GROK_SANDBOX, undefined);
  assert.equal(env.GROK_CLAUDE_MCPS_ENABLED, "false");
  assert.equal(env.GROK_SUBAGENTS, "0");
  const win = buildGrokEnv({ USERPROFILE: "C:\\Users\\me" }, { isolatedHome: "C:\\tmp\\iso", grokHome: "C:\\Users\\me\\.grok", platform: "win32" });
  assert.equal(win.USERPROFILE, "C:\\tmp\\iso");
});

test("resolveGrokHome prefers an explicit GROK_HOME", () => {
  assert.equal(resolveGrokHome({ GROK_HOME: "/custom" }, "/home/me"), "/custom");
  assert.equal(resolveGrokHome({}, "/home/me"), path.join("/home/me", ".grok"));
});

test("auditIsolation blocks active capability sources and reports instructions", () => {
  assert.deepEqual(
    auditIsolation({
      projectInstructions: [{ path: "AGENTS.md" }, { path: "CLAUDE.md", disabled: true }],
      plugins: [{ name: "codex", enabled: true }, { name: "off", enabled: false }],
      hooks: [{ target: "/x/hooks.json" }],
      mcpServers: [{ name: "railway", disabled: true }, { name: "vercel" }],
      lspServers: []
    }),
    { blocking: ["plugin: codex", "hook: /x/hooks.json", "MCP server: vercel"], instructions: ["AGENTS.md"] }
  );
  assert.deepEqual(auditIsolation({ plugins: [], hooks: [], mcpServers: [], lspServers: [], projectInstructions: [] }), { blocking: [], instructions: [] });
  assert.deepEqual(auditIsolation({}).blocking.length, 4, "missing lists fail closed");
  assert.deepEqual(auditIsolation(null).blocking, ["grok inspect returned no data"]);
});

test("describeSandbox is honest per platform", () => {
  assert.equal(describeSandbox("win32", "10.0", "C:\\repo", []).requested, false);
  assert.match(describeSandbox("win32", "10.0", "C:\\repo", []).detail, /NOT enforced/);
  assert.match(describeSandbox("linux", "5.4.0-100-generic", "/repo", []).detail, /NOT enforced.*5\.13/);
  assert.equal(describeSandbox("linux", "6.8.0", "/repo", []).enforced, "unconfirmed");
  assert.match(describeSandbox("darwin", "25.6.0", "/Users/x/repo", []).detail, /Seatbelt/);
  assert.match(describeSandbox("darwin", "25.6.0", "/tmp/repo", ["/tmp"]).detail, /NOT enforced for this repo/);
});

test("findGrokBinary searches PATH and ~/.grok/bin", (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "grok-bin-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const isWindows = process.platform === "win32";
  const name = isWindows ? "grok.exe" : "grok";
  const bin = path.join(dir, "bin");
  fs.mkdirSync(bin);
  fs.writeFileSync(path.join(bin, name), "", { mode: 0o755 });
  assert.equal(findGrokBinary({ PATH: bin }, process.platform), path.join(bin, name));

  const home = path.join(dir, "home");
  fs.mkdirSync(path.join(home, ".grok", "bin"), { recursive: true });
  fs.writeFileSync(path.join(home, ".grok", "bin", name), "", { mode: 0o755 });
  const homeKey = isWindows ? "USERPROFILE" : "HOME";
  assert.equal(findGrokBinary({ PATH: "", [homeKey]: home }, process.platform), path.join(home, ".grok", "bin", name));
});

test("findGrokBinary on Windows ignores .cmd shims", (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "grok-bin-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  fs.writeFileSync(path.join(dir, "grok.cmd"), "");
  assert.throws(() => findGrokBinary({ PATH: dir, USERPROFILE: dir }, "win32"), /grok\.exe not found/);
});

test("parseReviewOutput requires success and structured output", () => {
  const base = { signal: null, stderr: "", timedOut: false };
  assert.throws(() => parseReviewOutput({ ...base, status: 0, stdout: "", timedOut: true }), /timed out/);
  assert.throws(() => parseReviewOutput({ ...base, status: 0, stdout: JSON.stringify({ stopReason: "max_turns" }) }), /stop reason: max_turns/);
  const ok = parseReviewOutput({ ...base, status: 0, stdout: JSON.stringify({ sessionId: "s", num_turns: 2, structuredOutput: { verdict: "approve" } }) });
  assert.deepEqual(ok, { review: { verdict: "approve" }, sessionId: "s", numTurns: 2 });
});
