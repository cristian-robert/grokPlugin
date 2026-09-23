// @ts-check
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { auditIsolation, buildGrokEnv, buildSecretDenyRules, describeSandbox, findGrokBinary, parseModelsOutput, parseReviewOutput, resolveGrokHome, runProcess } from "../plugins/grok/scripts/lib/grok.mjs";

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
    { PATH: "/bin", HOME: "/real", GROK_SANDBOX: "off", GROK_CLAUDE_MCPS_ENABLED: "true", GITHUB_TOKEN: "x", GROK_CONFIG: "{}" },
    { isolatedHome: "/tmp/iso", grokHome: "/real/.grok", platform: "darwin" }
  );
  assert.equal(env.PATH, "/bin");
  assert.equal(env.HOME, "/tmp/iso");
  assert.equal(env.GROK_HOME, "/real/.grok");
  assert.equal(env.GROK_SANDBOX, undefined);
  assert.equal(env.GROK_CLAUDE_MCPS_ENABLED, "false");
  assert.equal(env.GROK_SUBAGENTS, "0");
  assert.equal(env.GITHUB_TOKEN, undefined);
  assert.equal(env.GROK_CONFIG, undefined);
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
  assert.throws(() => parseReviewOutput({ ...base, status: 0, stdout: JSON.stringify({ stopReason: "max_turns", structuredOutput: { verdict: "approve" } }) }), /stop reason: max_turns/);
  assert.throws(() => parseReviewOutput({ ...base, status: 0, stdout: JSON.stringify({ stopReason: "end_turn" }) }), /without a structured review/);
  const ok = parseReviewOutput({ ...base, status: 0, stdout: JSON.stringify({ stopReason: "end_turn", sessionId: "s", structuredOutput: { verdict: "approve" } }) });
  assert.deepEqual(ok, { review: { verdict: "approve" }, sessionId: "s" });
});

test("runProcess kills a child that ignores SIGTERM and still settles", async () => {
  const started = Date.now();
  const run = await runProcess(
    process.execPath,
    ["-e", "process.on('SIGTERM', () => {}); setInterval(() => {}, 1000)"],
    { env: process.env, cwd: process.cwd(), timeoutMs: 200 }
  );
  assert.equal(run.timedOut, true);
  assert.ok(Date.now() - started < 15_000);
  assert.throws(() => parseReviewOutput(run), /timed out/);
});

test("buildSecretDenyRules denies credential subtrees and every ancestor, never the repo", () => {
  const { rules, skipped } = buildSecretDenyRules({ repoRoot: "/Users/me/Dev/app", realHome: "/Users/me", grokHome: "/Users/me/.grok", platform: "darwin" });
  for (const expected of ["Read(/Users/me/.ssh/**)", "Read(/Users/me/.ssh)", "Read(/Users/me/.grok/**)", "Read(/Users/me)", "Read(/Users/me/Dev)", "Read(/Users)", "Read(/)"]) {
    assert.ok(rules.includes(expected), expected);
  }
  assert.ok(!rules.some((rule) => rule === "Read(/Users/me/Dev/app)" || rule.startsWith("Read(/Users/me/Dev/app/")));
  assert.deepEqual(skipped, []);
});

test("buildSecretDenyRules skips subtrees that contain the repo", () => {
  const { rules } = buildSecretDenyRules({ repoRoot: "/Users/me/.config/nvim", realHome: "/Users/me", grokHome: "/Users/me/.grok", platform: "darwin" });
  assert.ok(!rules.includes("Read(/Users/me/.config/**)"));
  assert.ok(!rules.includes("Read(/Users/me/.config/nvim)"));
  assert.ok(rules.includes("Read(/Users/me/.config)"), "the parent is still denied as an exact grep root");
});

test("buildSecretDenyRules on Windows uses forward slashes only, both drive-letter cases", () => {
  const { rules } = buildSecretDenyRules({ repoRoot: "C:\\src\\app", realHome: "C:\\Users\\me", grokHome: "C:\\Users\\me\\.grok", platform: "win32" });
  assert.ok(rules.every((rule) => !rule.includes("\\")), "no backslashes: grok's rule parser treats them as escapes");
  for (const expected of ["Read(C:/Users/me/.ssh/**)", "Read(c:/Users/me/.ssh/**)", "Read(C:/)", "Read(c:/)", "Read(C:/Users/me)", "Read(C:/src)"]) {
    assert.ok(rules.includes(expected), expected);
  }
  assert.ok(rules.every((rule) => /^Read\([^()]*\)$/.test(rule)), "every rule is a single balanced Read(...)");
});

test("buildSecretDenyRules skips paths that would need escaping instead of emitting malformed rules", () => {
  const { rules, skipped } = buildSecretDenyRules({ repoRoot: "C:\\Program Files (x86)\\app", realHome: "C:\\Users\\me", grokHome: "C:\\Users\\me\\.grok", platform: "win32" });
  assert.ok(skipped.includes("C:/Program Files (x86)"));
  const comma = buildSecretDenyRules({ repoRoot: "/Users/Smith, John/app", realHome: "/Users/Smith, John", grokHome: "/Users/Smith, John/.grok", platform: "darwin" });
  assert.ok(comma.skipped.includes("/Users/Smith, John"), "grok splits --deny on commas");
  assert.ok(comma.rules.every((rule) => !rule.includes(",")));
  assert.ok(rules.every((rule) => /^Read\([^()]*\)$/.test(rule)));
  assert.ok(rules.includes("Read(C:/)"));
});

test("auditIsolation reports repo skills and permission sources", () => {
  const audit = auditIsolation({
    plugins: [], hooks: [], mcpServers: [], lspServers: [], projectInstructions: [],
    skills: [{ name: "evil", source: { type: "project" } }, { name: "pdf", source: { type: "bundled" } }],
    permissions: { sources: ["/repo/.claude/settings.json"] }
  });
  assert.deepEqual(audit.blocking, []);
  assert.deepEqual(audit.instructions, ["skill evil", "permission rules from /repo/.claude/settings.json"]);
});
