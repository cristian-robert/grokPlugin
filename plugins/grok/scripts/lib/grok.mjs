// @ts-check
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";

export const DEFAULT_MAX_TURNS = 40;
export const DEFAULT_TIMEOUT_MS = 20 * 60 * 1000;

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
  const name = isWindows ? "grok.exe" : "grok";
  const home = (isWindows ? env.USERPROFILE : env.HOME) ?? "";
  const pathValue = env.PATH ?? env.Path ?? "";
  const candidates = [
    ...pathValue.split(isWindows ? ";" : ":").filter(Boolean).map((dir) => pathApi.join(dir, name)),
    ...(home ? [pathApi.join(home, ".grok", "bin", name), pathApi.join(home, ".local", "bin", name)] : [])
  ];
  for (const candidate of candidates) {
    try {
      fs.accessSync(candidate, isWindows ? fs.constants.F_OK : fs.constants.X_OK);
      if (fs.statSync(candidate).isFile()) {
        return candidate;
      }
    } catch {
      // not here; keep looking
    }
  }
  throw new Error(
    isWindows
      ? "grok.exe not found. Install it in PowerShell with: irm https://x.ai/cli/install.ps1 | iex"
      : "grok not found. Install it with: curl -fsSL https://x.ai/cli/install.sh | bash"
  );
}

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
  const env = { ...baseEnv, ...ISOLATION_ENV, HOME: options.isolatedHome, GROK_HOME: options.grokHome };
  if (options.platform === "win32") {
    env.USERPROFILE = options.isolatedHome;
  }
  delete env.GROK_SANDBOX;
  return env;
}

/**
 * @param {NodeJS.ProcessEnv} baseEnv
 * @param {string} realHome
 */
export function resolveGrokHome(baseEnv, realHome) {
  return baseEnv.GROK_HOME || path.join(realHome, ".grok");
}

/**
 * Decides from `grok inspect --json` whether anything that could add capabilities is still loaded.
 * Repository instruction files (AGENTS.md etc.) are allowed but reported, since blocking them
 * would block every repo that has one.
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
  return { blocking, instructions };
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
      return [fs.realpathSync(dir)];
    } catch {
      return [];
    }
  }))];
}

/**
 * @param {{ promptFile: string, model: string, effort: string | null, schemaJson: string, sandbox: boolean, cwd: string, maxTurns?: number }} options
 * @returns {string[]}
 */
export function buildReviewArgs(options) {
  const args = ["--prompt-file", options.promptFile, "-m", options.model, "--json-schema", options.schemaJson];
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
    ...DENY_RULES.flatMap((rule) => ["--deny", rule]),
    "--disable-web-search",
    "--no-subagents",
    "--max-turns", String(options.maxTurns ?? DEFAULT_MAX_TURNS),
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

/**
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
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill();
    }, options.timeoutMs ?? DEFAULT_TIMEOUT_MS);
    child.stdout.on("data", (chunk) => out.push(chunk));
    child.stderr.on("data", (chunk) => err.push(chunk));
    child.on("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.on("close", (status, signal) => {
      clearTimeout(timer);
      resolve({ status, signal, stdout: Buffer.concat(out).toString("utf8"), stderr: Buffer.concat(err).toString("utf8"), timedOut });
    });
  });
}

/**
 * @param {RunResult} run
 * @returns {{ review: unknown, sessionId: string | null, numTurns: number | null }}
 */
export function parseReviewOutput(run) {
  if (run.timedOut) {
    throw new Error("Grok timed out before finishing the review.");
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
  if (typeof parsed.structuredOutput !== "object" || parsed.structuredOutput === null) {
    const reason = typeof parsed.stopReason === "string" ? parsed.stopReason : "unknown";
    throw new Error(`Grok finished without a structured review (stop reason: ${reason}).`);
  }
  return {
    review: parsed.structuredOutput,
    sessionId: typeof parsed.sessionId === "string" ? parsed.sessionId : null,
    numTurns: typeof parsed.num_turns === "number" ? parsed.num_turns : null
  };
}
