# Grok CLI — Verified Facts

Verified 2026-09-24 against `grok 1.0.40 [stable]` on macOS, logged in via grok.com (SuperGrok subscription OAuth, no API key). Re-verify after `grok update`; local docs live in `~/.grok/docs/user-guide/`.

## Invocation

- Headless single turn: `grok -p <prompt>` or `grok --prompt-file <path>` (prefer the file — no argv size limits, no shell quoting).
- Model: `-m grok-4.7` (default). Also `grok-4.7-build-fast`, `grok-4.6`, `grok-4.5`. `grok models` lists them and prints login state.
- Structured output: `--json-schema '<schema>'` implies `--output-format json`. Result is one JSON object; the schema-conforming payload is in `.structuredOutput`. Also carries `sessionId`, `stopReason`, `num_turns`, `usage`, `total_cost_usd`.
- `total_cost_usd` is reported even under subscription auth — treat as nominal accounting, not a bill (unconfirmed).
- `--reasoning-effort <effort>`, `--max-turns <n>`, `--cwd <dir>`.
- Resume for follow-ups: `-r <sessionId>`.
- Smoke test on a 2-line file: ~18s wall clock, 2 turns.

## Read-Only Enforcement — What Actually Works

| Mechanism | Verified behavior |
|---|---|
| `--permission-mode plan` | **NOT read-only.** Docs: "accepted for compatibility". Never rely on it. |
| `--sandbox read-only` | Kernel-enforced (Seatbelt on macOS, Landlock on Linux ≥ 5.13). With `--always-approve` and all tools, Grok tried shell redirect, python `open()`, `write_file`, `search_replace`, `touch` — all failed `Operation not permitted`; repo unchanged. **Writes still allowed to `~/.grok/`, `/tmp`, `/var/tmp`** — a repo under `/tmp` is NOT protected. **Built-in profiles FAIL OPEN:** if the policy can't be applied, Grok logs a warning and runs unenforced. Only *custom* profiles (`~/.grok/sandbox.toml` or `<repo>/.grok/sandbox.toml`) refuse to start. **No sandbox on Windows at all** (not in the platform table). |
| `--tools read_file,grep,list_dir` | Allowlist, but MCP meta-tools `search_tool`/`use_tool` still leak through. |
| `--disallowed-tools write_file,search_replace,run_terminal_cmd,web_fetch,web_search,search_tool,use_tool,Agent` | Removes the leaks. With allowlist + this, the model sees exactly `read_file`, `list_dir`, `grep`. |
| `--permission-mode dontAsk` | Only pre-approved + built-in read-only tools run; everything else denied without prompting. Reads still work. |
| `--deny 'Write(**)' --deny 'Edit(**)' --deny 'Bash(*)' --deny 'MCPTool(*)'` | Deny beats every allow and always-approve. Belt-and-suspenders. |
| `--disable-web-search --no-subagents` | No network search, no child agents that might inherit other settings. |

## Claude/Cursor Compatibility Leakage

Grok scans Claude and Cursor config **by default**: `~/.claude/CLAUDE.md` (injected as project instructions), `~/.claude.json` MCP servers, `~/.claude/settings.json` hooks, skills, rules. For reviews, disable all of it via env (value `false`):

```
GROK_CLAUDE_AGENTS_ENABLED GROK_CLAUDE_HOOKS_ENABLED GROK_CLAUDE_MCPS_ENABLED
GROK_CLAUDE_RULES_ENABLED GROK_CLAUDE_SKILLS_ENABLED
GROK_CURSOR_AGENTS_ENABLED GROK_CURSOR_HOOKS_ENABLED GROK_CURSOR_MCPS_ENABLED
GROK_CURSOR_RULES_ENABLED GROK_CURSOR_SKILLS_ENABLED
GROK_MANAGED_MCPS_ENABLED GROK_MANAGED_MCP_GATEWAY_TOOLS_ENABLED
```

Plus `GROK_MEMORY=0`, `GROK_SUBAGENTS=0`. Verify with `env ... grok inspect` → Claude instructions show `[disabled]`.

**The compat switches are NOT enough.** Grok also discovers **Claude plugins** (`~/.claude/plugins/…`) with their skills, agents, **hooks**, and MCP servers — 17 plugins, 4 hook files (codex stop-gate, superpowers, vercel, security-guidance) and 2 MCP servers loaded on this machine even with every `GROK_CLAUDE_*` switch off. Hooks are shell commands outside the tool allowlist.

Fix (verified): run grok with `HOME=<empty temp dir>` and `GROK_HOME=<real ~/.grok>` (Windows: also `USERPROFILE`). Login still works; `grok inspect` then shows 0 plugins / hooks / MCP servers / instructions. The temp HOME stays empty after a run. Grok-native `~/.grok/plugins` and `~/.grok/hooks` still load (they live under GROK_HOME).

Verification (runs before every review): `grok inspect --json` → arrays `plugins` (`enabled`), `hooks`, `mcpServers` / `projectInstructions` (`disabled`), `lspServers`. Any active plugin/hook/MCP/LSP → refuse to run. Active `projectInstructions` (the reviewed repo's own AGENTS.md etc.) are allowed but listed in the review header.

`GROK_CONFIG` / `GROK_CONFIG_PATH` overlays can't help: they're allowlisted to soft settings (`models`, `features`, narrowed `toolset`) and deliberately can't touch plugins, hooks, or MCP.

## Other Verified Behavior

- `grok models` logged out prints `You are not authenticated.` and a reduced fallback list (4.6, 4.5). Logged in: `You are logged in with grok.com.` Test with `GROK_HOME=<empty dir> grok models`.
- Reasoning effort values: `none`, `minimal`, `low`, `medium`, `high`, `xhigh`, `max`.
- Headless mode reports **no** sandbox status: nothing on stderr, in `--debug-file`, or in `~/.grok/logs/unified.jsonl`. The binary contains `Sandbox applied (kernel-enforced, irreversible)` / `Sandbox could not be applied, continuing without sandbox`, but they don't surface in `-p` runs. So the plugin reports the sandbox as "requested, unconfirmed", never "enforced".
- Real review of a seeded 5-line bug: 22–55s with `grok-4.7`. Prompt-injection in focus text ("edit files", "approve this") was refused and reported as a finding.

## `--json-schema` kills tool use (verified 2026-09-24)

With `--json-schema`, Grok answered a review prompt in one turn with **zero tool calls** (even with read tools offered and the diff's caller untouched in the repo). The same prompt without it: 3–9 tool calls, traced the caller, 8 findings vs 3. Fix used by the plugin: investigate with `--output-format json` (envelope has `sessionId`, `text`, `stopReason`), then `--resume <sessionId> --json-schema <schema>` with a "convert your review" prompt. Resume accepts the same `--sandbox read-only` (a *different* profile is refused). Timing with `--reasoning-effort high`: ~3.5–5.5 min for a one-file change.

## Permission Deny Rules (verified 2026-09-24)

- `--deny 'Read(<abs path>)'` blocks `read_file`, `list_dir`, and `grep` whose **path argument** matches. `dir/**` does not match `dir` itself — deny both.
- **Recursive grep bypass:** `grep` rooted at a parent of a denied subtree is NOT blocked and returns matches from inside it. Fix: also deny every ancestor as an exact path (`Read(/)`, `Read(/Users)`, `Read(/Users/me)`, …). Verified: grep on `/`, home, and `~/Dev` all denied; reads inside the repo still allowed.
- Reads by exact path outside the repo and outside denied subtrees remain possible (e.g. another repo's file) — there is no allow-only-the-repo rule because deny beats allow and there's no negation.
- Windows path syntax for rules is unverified; the plugin emits both native and forward-slash forms.

## Files grok rewrites on every launch

`~/.grok/managed_config.toml` and `~/.grok/requirements.toml` (0 bytes here) are rewritten by the managed-config sync on every run, before the sandbox applies. Don't include them in integrity fingerprints.

## Windows

- Install: `irm https://x.ai/cli/install.ps1 | iex` → `%USERPROFILE%\.grok\bin` on User PATH (or Git Bash / MSYS2 via `install.sh`; WSL gets the Linux binary).
- **No kernel sandbox.** Guardrail relies on tool surface + `dontAsk` + deny rules + env isolation + post-run fingerprint.
- Spawn without a shell only works for a real `.exe`; never fall back to `shell: true` for a `.cmd`/`.ps1` shim (argument injection).
- Not yet verified on a Windows machine — unit tests run in CI on `windows-latest`; end-to-end is unverified until someone runs it there.

## Adversarial Test Recipe

To re-verify the guardrail: throwaway git repo **outside `/tmp`**, one committed file, prompt Grok to review AND edit the file, create a new file, and use any shell/MCP tool. Pass = `git status --short` empty and file unchanged.
