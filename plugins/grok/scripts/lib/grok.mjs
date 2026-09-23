// @ts-check
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";

import { findExecutable } from "./exec.mjs";

export const DEFAULT_EFFORT = "high";
export const DEFAULT_TIMEOUT_MS = 9 * 60 * 1000;

const READ_TOOLS = ["read_file", "grep", "list_dir"];
const BLOCKED_TOOLS = ["write_file", "search_replace", "run_terminal_cmd", "web_fetch", "web_search", "search_tool", "use_tool", "Agent"];
const DENY_RULES = ["Write(**)", "Edit(**)", "Bash(*)", "MCPTool(*)"];

// Grok imports Claude/Cursor instructions, MCP servers, hooks, skills and rules by default.
// A reviewer must see none of that: it could add write-capable tools or steer the review.
const ISOLATION_ENV = {
  GROK_CLAUDE_AGENTS_ENABLED: "false",
  GROK_CLAUDE_HOOKS_ENABLED: "false",
  GROK_CLAUDE_MCPS_ENABLED: "false",
  GROK_CLAUDE_RULES_ENABLED: "false",
  GROK_CLAUDE_SKILLS_ENABLED: "false",
  GROK_CURSOR_AGENTS_ENABLED: "false",
  GROK_CURSOR_HOOKS_ENABLED: "false",
  GROK_CURSOR_MCPS_ENABLED: "false",
  GROK_CURSOR_RULES_ENABLED: "false",
  GROK_CURSOR_SKILLS_ENABLED: "false",
  GROK_MANAGED_MCPS_ENABLED: "false",
  GROK_MANAGED_MCP_GATEWAY_TOOLS_ENABLED: "false",
  GROK_MEMORY: "0",
  GROK_SUBAGENTS: "0"
};

/**
 * @typedef {{ requested: boolean, enforced: "unconfirmed" | "no", detail: string }} SandboxStatus
 * @typedef {{ loggedIn: boolean, defaultModel: string | null, models: string[] }} ModelList
 * @typedef {{ status: number | null, signal: NodeJS.Signals | null, stdout: string, stderr: string, timedOut: boolean }} RunResult
 * @typedef {{ command: string, prefixArgs: string[] }} GrokCommand
 */

/**
 * Finds a directly executable grok binary. On Windows only a real .exe qualifies:
 * .cmd/.ps1 shims need a shell, and a shell would parse repository-derived arguments.
 * @param {NodeJS.ProcessEnv} env
 * @param {NodeJS.Platform} platform
 * @returns {string}
 */
export function findGrokBinary(env, platform) {
  const isWindows = platform === "win32";
  const pathApi = isWindows ? path.win32 : path.posix;
  const home = (isWindows ? env.USERPROFILE : env.HOME) ?? "";
  const found = findExecutable("grok", env, platform, home ? [pathApi.join(home, ".grok", "bin"), pathApi.join(home, ".local", "bin")] : []);
  if (found) {
    return found;
  }
  throw new Error(
    isWindows
      ? "grok.exe not found. Install it in PowerShell with: irm https://x.ai/cli/install.ps1 | iex"
      : "grok not found. Install it with: curl -fsSL https://x.ai/cli/install.sh | bash"
  );
}

// Only what grok needs to run, authenticate, and reach the network. Everything else (cloud
// credentials, tokens, GROK_* overrides such as GROK_CONFIG or GROK_FOLDER_TRUST) stays out.
const PASSTHROUGH_ENV = [
  "PATH", "Path", "PATHEXT", "SystemRoot", "SYSTEMROOT", "windir", "ComSpec", "COMSPEC", "SystemDrive",
  "TEMP", "TMP", "TMPDIR", "APPDATA", "LOCALAPPDATA", "ProgramData", "ProgramFiles", "ProgramFiles(x86)",
  "USER", "USERNAME", "LOGNAME", "SHELL", "LANG", "LC_ALL", "LC_CTYPE", "TERM", "TZ",
  "XDG_RUNTIME_DIR", "DBUS_SESSION_BUS_ADDRESS",
  "HTTP_PROXY", "HTTPS_PROXY", "NO_PROXY", "ALL_PROXY", "http_proxy", "https_proxy", "no_proxy", "all_proxy",
  "SSL_CERT_FILE", "SSL_CERT_DIR",
  "XAI_API_KEY", "GROK_CODE_XAI_API_KEY"
];

/**
 * Grok also discovers Claude plugins (with their hooks and MCP servers) through the home
 * directory, which no compat switch covers. Pointing HOME at an empty directory hides them;
 * GROK_HOME keeps pointing at the real ~/.grok so the subscription login still works.
 * @param {NodeJS.ProcessEnv} baseEnv
 * @param {{ isolatedHome: string, grokHome: string, platform: NodeJS.Platform }} options
 * @returns {NodeJS.ProcessEnv}
 */
export function buildGrokEnv(baseEnv, options) {
  /** @type {NodeJS.ProcessEnv} */
  const env = {};
  for (const key of PASSTHROUGH_ENV) {
    if (baseEnv[key] !== undefined) {
      env[key] = baseEnv[key];
    }
  }
  Object.assign(env, ISOLATION_ENV, { HOME: options.isolatedHome, GROK_HOME: options.grokHome, GROK_DISABLE_AUTOUPDATER: "1" });
  if (options.platform === "win32") {
    env.USERPROFILE = options.isolatedHome;
  }
  return env;
}

// Credential stores a prompt-injected reviewer could otherwise read and quote into a finding.
const SECRET_HOME_ENTRIES = [
  ".ssh", ".aws", ".gnupg", ".config", ".docker", ".kube", ".azure", ".claude", ".claude.json", ".codex",
  ".cursor", ".netrc", ".npmrc", ".pypirc", ".git-credentials", ".pgpass", ".password-store", ".terraform.d",
  ".bash_history", ".zsh_history", ".vault-token", "Library/Keychains", "AppData"
];

/**
 * Read deny rules for credential locations. Deny rules match the path a tool is given, so a
 * grep rooted at a parent directory would still recurse into a denied subtree; every ancestor
 * of those locations (and of the repo) is therefore denied as an exact path too. The repo and
 * anything inside it stay readable.
 * @param {{ repoRoot: string, realHome: string, grokHome: string, platform: NodeJS.Platform }} options
 * @returns {{ rules: string[], skipped: string[] }} skipped: paths that couldn't be written as a safe rule
 */
export function buildSecretDenyRules(options) {
  const pathApi = options.platform === "win32" ? path.win32 : path.posix;
  const repo = pathApi.resolve(options.repoRoot);
  /** @param {string} target */
  const containsRepo = (target) => {
    const relative = pathApi.relative(target, repo);
    return relative === "" || (!relative.startsWith("..") && !pathApi.isAbsolute(relative));
  };
  const subtrees = [
    options.grokHome,
    ...SECRET_HOME_ENTRIES.map((entry) => pathApi.join(options.realHome, entry)),
    ...(options.platform === "linux" ? ["/proc"] : [])
  ].map((target) => pathApi.resolve(target)).filter((target) => !containsRepo(target));

  /** @type {Set<string>} */
  const exact = new Set();
  for (const start of [repo, ...subtrees]) {
    let current = pathApi.dirname(start);
    for (;;) {
      exact.add(current);
      const parent = pathApi.dirname(current);
      if (parent === current) {
        break;
      }
      current = parent;
    }
  }
  exact.delete(repo);

  /** @type {string[]} */
  const rules = [];
  /** @type {string[]} */
  const skipped = [];
  /** @param {string} target */
  const add = (target) => {
    // Grok's rule parser treats "\" as an escape (Read(C:\) is "missing closing parenthesis"),
    // and glob patterns use "/" as the separator, so Windows paths are written with "/".
    const pattern = options.platform === "win32" ? target.replace(/\\/g, "/") : target;
    const literal = pattern.endsWith("/**") ? pattern.slice(0, -3) : pattern;
    // One malformed rule makes grok refuse the whole run, so paths that would need glob or
    // rule-syntax escaping are skipped (and reported) instead of guessed at. Commas matter too:
    // grok splits --deny values on "," (verified: Read(/a,b/x) is "missing closing parenthesis").
    if (/[()[\]{}*?\\,]/.test(literal)) {
      skipped.push(literal);
      return;
    }
    rules.push(`Read(${pattern})`);
    const drive = pattern.match(/^([A-Za-z]):/);
    if (drive) {
      const other = drive[1] === drive[1].toUpperCase() ? drive[1].toLowerCase() : drive[1].toUpperCase();
      rules.push(`Read(${other}${pattern.slice(1)})`);
    }
  };
  for (const target of subtrees) {
    add(target);
    add(pathApi.join(target, "**"));
  }
  for (const target of [...exact].sort()) {
    add(target);
  }
  return { rules: [...new Set(rules)], skipped: [...new Set(skipped)] };
}

/**
 * @param {NodeJS.ProcessEnv} baseEnv
 * @param {string} realHome
 */
export function resolveGrokHome(baseEnv, realHome) {
  return baseEnv.GROK_HOME || path.join(realHome, ".grok");
}

/**
 * Lists, from `grok inspect --json`, anything still loaded that could add capabilities (reported
 * in the review header; the tool allowlist keeps Grok from calling MCP or plugin tools).
 * Repository-supplied instructions, skills, and permission rules (a trusted folder's AGENTS.md,
 * .grok/ or .claude/ config) are allowed but reported: blocking them would block every such repo,
 * and the CLI flags and deny rules still win over them.
 * @param {unknown} inspect
 * @returns {{ blocking: string[], instructions: string[] }}
 */
export function auditIsolation(inspect) {
  if (typeof inspect !== "object" || inspect === null) {
    return { blocking: ["grok inspect returned no data"], instructions: [] };
  }
  const data = /** @type {Record<string, unknown>} */ (inspect);
  /** @param {unknown} entry */
  const isActive = (entry) => {
    const item = /** @type {Record<string, unknown>} */ (entry ?? {});
    return item.disabled !== true && item.enabled !== false;
  };
  /** @param {unknown} entry */
  const describe = (entry) => {
    const item = /** @type {Record<string, unknown>} */ (entry ?? {});
    return String(item.name ?? item.target ?? item.path ?? JSON.stringify(item).slice(0, 80));
  };
  /** @type {string[]} */
  const blocking = [];
  for (const [key, label] of [["plugins", "plugin"], ["hooks", "hook"], ["mcpServers", "MCP server"], ["lspServers", "LSP server"]]) {
    const list = data[key];
    if (!Array.isArray(list)) {
      blocking.push(`grok inspect has no ${key} list`);
      continue;
    }
    blocking.push(...list.filter(isActive).map((entry) => `${label}: ${describe(entry)}`));
  }
  const instructions = Array.isArray(data.projectInstructions) ? data.projectInstructions.filter(isActive).map(describe) : [];
  const skills = Array.isArray(data.skills)
    ? data.skills
        .filter((entry) => {
          const source = /** @type {Record<string, unknown>} */ (/** @type {Record<string, unknown>} */ (entry ?? {}).source ?? {});
          return isActive(entry) && source.type !== "bundled" && source.type !== "builtin";
        })
        .map((entry) => `skill ${describe(entry)}`)
    : [];
  const permissions = /** @type {Record<string, unknown>} */ (data.permissions ?? {});
  const permissionSources = Array.isArray(permissions.sources) ? permissions.sources.map((source) => `permission rules from ${typeof source === "string" ? source : describe(source)}`) : [];
  return { blocking, instructions: [...instructions, ...skills, ...permissionSources] };
}

/**
 * @param {GrokCommand} grok
 * @param {NodeJS.ProcessEnv} env
 * @param {string} cwd
 */
export function inspectIsolation(grok, env, cwd) {
  const result = spawnSync(grok.command, [...grok.prefixArgs, "inspect", "--json"], { cwd, env, encoding: "utf8", shell: false, windowsHide: true, timeout: 60_000 });
  if (result.error || result.status !== 0) {
    throw new Error(`grok inspect failed, so isolation cannot be verified: ${result.error?.message ?? (result.stderr || result.stdout).trim()}`);
  }
  try {
    return auditIsolation(JSON.parse(result.stdout));
  } catch {
    throw new Error("grok inspect returned non-JSON output, so isolation cannot be verified.");
  }
}

/**
 * @param {NodeJS.Platform} platform
 * @param {string} osRelease
 * @param {string} repoRoot
 * @param {string[]} sandboxWritableDirs
 * @returns {SandboxStatus}
 */
export function describeSandbox(platform, osRelease, repoRoot, sandboxWritableDirs) {
  if (platform === "win32") {
    return { requested: false, enforced: "no", detail: "NOT enforced: Grok has no sandbox on Windows" };
  }
  if (platform !== "darwin" && platform !== "linux") {
    return { requested: false, enforced: "no", detail: `NOT enforced: Grok has no sandbox on ${platform}` };
  }
  if (platform === "linux") {
    const [major, minor] = osRelease.split(".").map((part) => Number.parseInt(part, 10));
    if (major < 5 || (major === 5 && minor < 13)) {
      return { requested: true, enforced: "no", detail: `NOT enforced: Landlock needs Linux 5.13+, this kernel is ${osRelease}` };
    }
  }
  const writableParent = sandboxWritableDirs.find((dir) => isInside(repoRoot, dir));
  if (writableParent) {
    return { requested: true, enforced: "no", detail: `NOT enforced for this repo: it is inside ${writableParent}, which the read-only sandbox leaves writable` };
  }
  const mechanism = platform === "darwin" ? "Seatbelt" : "Landlock";
  return { requested: true, enforced: "unconfirmed", detail: `read-only (${mechanism}) requested; Grok does not confirm enforcement in headless mode` };
}

/**
 * @param {string} child
 * @param {string} parent
 */
function isInside(child, parent) {
  const relative = path.relative(parent, child);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

/**
 * Directories the built-in read-only profile leaves writable, resolved to real paths.
 * @param {string} grokHome
 */
export function sandboxWritableDirs(grokHome) {
  const dirs = [os.tmpdir(), "/tmp", "/var/tmp", grokHome];
  return [...new Set(dirs.flatMap((dir) => {
    try {
      return [fs.realpathSync.native(dir)];
    } catch {
      return [];
    }
  }))];
}

/**
 * No --max-turns: a review that hits a turn cap is discarded (see parseReviewOutput), so depth is
 * bounded by the wall-clock timeout instead.
 * @param {{ promptFile: string, model: string, effort: string | null, schemaJson?: string | null, resumeSessionId?: string | null, sandbox: boolean, cwd: string, extraDenyRules?: string[] }} options
 * @returns {string[]}
 */
export function buildReviewArgs(options) {
  const args = ["--prompt-file", options.promptFile, "-m", options.model];
  if (options.resumeSessionId) {
    args.push("--resume", options.resumeSessionId);
  }
  // --json-schema makes Grok answer immediately without using its tools, so only the final
  // formatting step is constrained; the investigation step runs free with JSON envelope output.
  args.push(...(options.schemaJson ? ["--json-schema", options.schemaJson] : ["--output-format", "json"]));
  if (options.effort) {
    args.push("--reasoning-effort", options.effort);
  }
  if (options.sandbox) {
    args.push("--sandbox", "read-only");
  }
  args.push(
    "--permission-mode", "dontAsk",
    "--tools", READ_TOOLS.join(","),
    "--disallowed-tools", BLOCKED_TOOLS.join(","),
    ...[...DENY_RULES, ...(options.extraDenyRules ?? [])].flatMap((rule) => ["--deny", rule]),
    "--disable-web-search",
    "--no-subagents",
    "--cwd", options.cwd
  );
  return args;
}

/**
 * @param {string} text output of `grok models`
 * @returns {ModelList}
 */
export function parseModelsOutput(text) {
  const loggedIn = /logged in/i.test(text) && !/not authenticated/i.test(text);
  const defaultMatch = text.match(/^Default model:\s*(\S+)/m);
  /** @type {string[]} */
  const models = [];
  const listStart = text.search(/^Available models:/m);
  if (listStart !== -1) {
    for (const line of text.slice(listStart).split(/\r?\n/).slice(1)) {
      const match = line.match(/^\s*[*-]\s+(\S+)/);
      if (match) {
        models.push(match[1]);
      }
    }
  }
  return { loggedIn, defaultModel: defaultMatch ? defaultMatch[1] : null, models };
}

/**
 * @param {GrokCommand} grok
 * @param {NodeJS.ProcessEnv} env
 * @returns {ModelList}
 */
export function listModels(grok, env) {
  const result = spawnSync(grok.command, [...grok.prefixArgs, "models"], { env, encoding: "utf8", shell: false, windowsHide: true, timeout: 60_000 });
  if (result.error) {
    throw new Error(`Could not run grok: ${result.error.message}`);
  }
  if (result.status !== 0) {
    throw new Error(`grok models failed: ${(result.stderr || result.stdout).trim()}`);
  }
  const list = parseModelsOutput(result.stdout);
  if (!list.loggedIn) {
    throw new Error("Grok is not logged in. Run `grok login` in a terminal (in Claude Code: `! grok login`), then retry.");
  }
  return list;
}

const KILL_GRACE_MS = 5000;

/**
 * Runs a child with a hard deadline: SIGTERM at the timeout, SIGKILL after a grace period, and
 * the promise settles even if a grandchild keeps the output pipes open. If this node process is
 * itself terminated (for example by a Bash tool timeout), the child is killed with it.
 * @param {string} command
 * @param {string[]} args
 * @param {{ env: NodeJS.ProcessEnv, cwd: string, timeoutMs?: number }} options
 * @returns {Promise<RunResult>}
 */
export function runProcess(command, args, options) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd: options.cwd, env: options.env, shell: false, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
    /** @type {Buffer[]} */
    const out = [];
    /** @type {Buffer[]} */
    const err = [];
    let timedOut = false;
    let settled = false;
    /** @type {NodeJS.Timeout | undefined} */
    let killTimer;

    const killOnParentExit = () => child.kill("SIGKILL");
    /** @param {NodeJS.Signals} signal */
    const onParentSignal = (signal) => {
      child.kill("SIGKILL");
      process.exit(signal === "SIGINT" ? 130 : 143);
    };
    process.once("exit", killOnParentExit);
    process.once("SIGTERM", onParentSignal);
    process.once("SIGINT", onParentSignal);

    /** @param {() => void} finish */
    const settle = (finish) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      clearTimeout(killTimer);
      process.removeListener("exit", killOnParentExit);
      process.removeListener("SIGTERM", onParentSignal);
      process.removeListener("SIGINT", onParentSignal);
      finish();
    };
    /** @param {number | null} status @param {NodeJS.Signals | null} signal */
    const done = (status, signal) =>
      settle(() => resolve({ status, signal, stdout: Buffer.concat(out).toString("utf8"), stderr: Buffer.concat(err).toString("utf8"), timedOut }));

    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGTERM");
      killTimer = setTimeout(() => {
        child.kill("SIGKILL");
        child.stdout.destroy();
        child.stderr.destroy();
        done(null, "SIGKILL");
      }, KILL_GRACE_MS);
    }, options.timeoutMs ?? DEFAULT_TIMEOUT_MS);

    child.stdout.on("data", (chunk) => out.push(chunk));
    child.stderr.on("data", (chunk) => err.push(chunk));
    child.on("error", (error) => settle(() => reject(error)));
    child.on("close", done);
  });
}

/**
 * Detects grok refusing to start because its kernel sandbox can't be set up (e.g. on Linux,
 * grok 1.0.41 refuses when it can't read /run/podman/podman.sock to build its deny list).
 * @param {RunResult} run
 * @returns {string | null} grok's reason, or null when the run did not fail that way
 */
export function sandboxStartupFailure(run) {
  if (run.status === 0 || run.timedOut) {
    return null;
  }
  const text = `${run.stderr}\n${run.stdout}`;
  if (!/sandbox/i.test(text) || !/refusing to start|could not enforce|could not be applied|sandbox profile resolve failed|sandbox initialization failed/i.test(text)) {
    return null;
  }
  const firstLine = text.split(/\r?\n/).map((line) => line.replace(/^error:\s*/i, "").trim()).find(Boolean) ?? "unknown reason";
  return firstLine.slice(0, 240);
}

/**
 * @param {RunResult} run
 * @returns {Record<string, unknown>} the parsed JSON envelope of a run that finished normally
 */
function parseEnvelope(run) {
  if (run.timedOut) {
    throw new Error("Grok timed out before finishing the review. Retry with --background (which allows 30 minutes) or a smaller --scope.");
  }
  if (run.status !== 0) {
    throw new Error(`Grok exited with ${run.status ?? run.signal}: ${(run.stderr || run.stdout).trim().slice(0, 2000)}`);
  }
  /** @type {Record<string, unknown>} */
  let parsed;
  try {
    parsed = JSON.parse(run.stdout);
  } catch {
    throw new Error(`Grok returned non-JSON output: ${run.stdout.trim().slice(0, 500)}`);
  }
  const reason = typeof parsed.stopReason === "string" ? parsed.stopReason : "unknown";
  if (reason !== "end_turn") {
    throw new Error(`Grok stopped before finishing the review (stop reason: ${reason}).`);
  }
  return parsed;
}

/**
 * The investigation step: a free-form review plus the session to resume for formatting.
 * @param {RunResult} run
 * @returns {{ sessionId: string, text: string }}
 */
export function parseInvestigation(run) {
  const parsed = parseEnvelope(run);
  if (typeof parsed.sessionId !== "string" || !parsed.sessionId) {
    throw new Error("Grok finished the investigation without a session id to resume.");
  }
  return { sessionId: parsed.sessionId, text: typeof parsed.text === "string" ? parsed.text : "" };
}

/**
 * The formatting step: the structured review.
 * @param {RunResult} run
 * @returns {{ review: unknown, sessionId: string | null }}
 */
export function parseReviewOutput(run) {
  const parsed = parseEnvelope(run);
  if (typeof parsed.structuredOutput !== "object" || parsed.structuredOutput === null) {
    throw new Error(`Grok finished without a structured review (stop reason: ${String(parsed.stopReason)}).`);
  }
  return {
    review: parsed.structuredOutput,
    sessionId: typeof parsed.sessionId === "string" ? parsed.sessionId : null
  };
}
