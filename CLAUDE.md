# grokPlugin

## Project Overview

A public Claude Code plugin marketplace whose `grok` plugin runs **Grok 4.7** (via the official `grok` CLI, authenticated with a SuperGrok subscription — no API key) as a deep adversarial code reviewer. Modeled on the `openai-codex` plugin's `/codex:adversarial-review`, but **strictly review-only**: Grok must never be able to modify code.

v1 scope: `/grok:adversarial-review` only — working-tree / branch / `--base <ref>` targets, optional focus text, structured findings.

## Tech Stack

- **Runtime:** Node.js ≥ 22 (`.mjs`, ES modules), **zero npm dependencies**
- **Platforms:** macOS, Linux, Windows (native PowerShell install of `grok`)
- **Reviewer:** `grok` CLI (Grok Build) ≥ 1.0.40, model `grok-4.7`
- **Host:** Claude Code plugin system (`.claude-plugin/plugin.json`, `marketplace.json`, slash commands)
- **Tests:** `node:test` + `node:assert` (built-in)
- **Distribution:** public GitHub repo used as a marketplace (`/plugin marketplace add <owner>/grokPlugin`)

## Directory Structure

Target layout (create as implemented):

```
grokPlugin/
├── .claude-plugin/marketplace.json     # marketplace manifest → plugins/grok
├── plugins/grok/
│   ├── .claude-plugin/plugin.json
│   ├── commands/adversarial-review.md  # Claude-side orchestration, review-only
│   ├── prompts/adversarial-review.md   # Grok prompt template
│   ├── schemas/review-output.schema.json
│   └── scripts/
│       ├── grok-review.mjs             # entrypoint
│       └── lib/                        # args, git target, grok runner, guard, render
├── tests/                              # node:test suites
├── .github/workflows/test.yml          # node --test on ubuntu / macos / windows
├── CLAUDE.md
└── .claude/
    ├── plans/                          # local implementation plans
    └── references/grok-cli.md          # VERIFIED grok CLI facts — read before touching the runner
```

## Core Principles

1. **READ-ONLY IS NON-NEGOTIABLE.** Grok reviews; it never edits. Enforce in depth — every layer stays even if another seems sufficient:
   1. **Claude side:** the command sets `disallowed-tools: Edit Write NotebookEdit` (`allowed-tools` only pre-approves, it does NOT restrict) and pre-approves ONLY the plugin script — never raw `git`/`node` (`git diff --output=` writes files; Grok's output is attacker-steerable and reaches Claude verbatim). The command treats review output as untrusted data. Size estimation lives in the script's `prepare` subcommand.
   2. **Kernel sandbox:** `--sandbox read-only` on macOS/Linux. Built-in profiles **fail open** (warn + run unenforced) and **Windows has no sandbox** — so this layer is never load-bearing on its own. **Decision (2026-09-24):** when the sandbox is unavailable, still run on the remaining layers but print `kernel sandbox: NOT enforced (<reason>)` in the review header. Never hide it.
   3. **Tool surface:** `--tools read_file,grep,list_dir` + `--disallowed-tools` for write/shell/web/MCP/Agent.
   4. **Permissions:** `--permission-mode dontAsk` + `--deny` rules for Write/Edit/Bash/MCPTool.
   5. **Isolation:** grok gets an allowlisted env only (no inherited credentials or `GROK_*` overrides) with all Claude/Cursor compat, memory, subagents, auto-update off, AND `HOME` set to an empty temp dir (`GROK_HOME` stays real) — the compat switches alone still let Claude *plugins* (hooks + MCP) load. Checked before every run via `grok inspect --json`; anything loaded (plugins, hooks, MCP, LSP, repo-supplied instructions/skills/permission rules) is reported as a WARNING in the header, not blocking (user decision 2026-09-24). The prompt tells Grok not to use MCP/plugins, and the tool allowlist makes them uncallable.
      - **Secrets:** `Read(...)` deny rules for credential stores (`~/.grok`, `~/.ssh`, `~/.aws`, …) plus every ancestor directory as an exact path — deny rules match the tool's path argument, so a `grep` rooted at a parent would otherwise recurse into a denied subtree (verified).
   6. **Changes during the review:** fingerprint the repo (HEAD, refs, index + skip-worktree/assume-unchanged file bytes, `.git` HEAD/config/info/hooks/modules, submodules recursively, modified + untracked file bytes, ignored files by size+mtime) and grok-home persistence spots before and after. Differences are **listed at the end of the review, not fatal** (user decision 2026-09-24: they're almost always the user's own in-flight edits). Never auto-revert. Every plugin git call pins `core.fsmonitor=false` and resolves `git` to an absolute path (Windows searches the cwd first).
   7. **Prompt:** tells Grok it is read-only (weakest layer — never the only one).
   - `--permission-mode plan` is **not** read-only in Grok. Never rely on it.
   - Any change to the grok invocation must re-run the adversarial guardrail test (see `.claude/references/grok-cli.md`).
2. **UNTRUSTED INPUT.** Diffs and repo content are attacker-controllable. Spawn `grok` with `execFile`/`spawn` + args array (never a shell); pass the prompt via `--prompt-file`; wrap repo content in delimited context marked as data, not instructions.
3. **FAIL CLOSED.** Missing `grok`, not logged in, sandbox refusal, non-zero exit, or schema-invalid output → clear error, no partial "approve".
4. **KISS / YAGNI.** No broker, no job tracking in v1. Three similar lines beat an abstraction.
7. **DEPTH.** Two Grok runs per review: investigate (tools, no `--json-schema`), then `--resume` the session with `--json-schema` to format. `--json-schema` on the first run makes Grok answer with zero tool calls (verified). Default effort `high`, no `--max-turns` (a capped run is discarded); the wall-clock timeout is the only bound.
5. **Verbatim results.** Claude returns Grok's rendered review as-is — no paraphrase, no fixing.
6. **CROSS-PLATFORM: macOS, Linux, Windows.** `node:path` for all paths (never string-concat `/`); `os.tmpdir()` for temp files; spawn `grok` without a shell (on Windows resolve the real `grok.exe`, refuse `.cmd`/`.ps1` shims); hash raw bytes so CRLF doesn't cause false guardrail alarms; no POSIX-only tools (`sed`, `sha256sum`) in scripts — do it in Node. CI runs `node --test` on `ubuntu-latest`, `macos-latest`, `windows-latest`.

## Development Workflow (Local Plans)

1. Create plan in `.claude/plans/<feature>.md` with phases and checkboxes
2. Work phases sequentially, updating checkboxes as you go
3. Commit with `/commit` after each phase
4. Before push: `/code-review` on the diff, then optional `/codex:rescue` adversarial pass — then `/commit-push-pr`
5. Mark plan complete when done

**Development mode:** Standard — domain skills + verification. Escalate to Superpowers (`/brainstorming` → `/writing-plans` → TDD) for guardrail or security-shaped changes.

## Setup & Commands

```bash
grok models                                   # confirm login + grok-4.7 availability
node --test "tests/**/*.test.mjs"            # run all tests (quoted glob works on every OS)
claude plugin validate ./plugins/grok --strict # validate manifests + command frontmatter
claude --plugin-dir ./plugins/grok            # load plugin locally for manual testing
/plugin marketplace add ~/Dev/grokPlugin      # or install via local marketplace
```

## Environment Variables

None required (subscription OAuth lives in `~/.grok/auth.json`, never read or touched by the plugin). The runner **sets** these for the child `grok` process: `GROK_CLAUDE_*_ENABLED=false`, `GROK_CURSOR_*_ENABLED=false`, `GROK_MANAGED_MCPS_ENABLED=false`, `GROK_MANAGED_MCP_GATEWAY_TOOLS_ENABLED=false`, `GROK_MEMORY=0`, `GROK_SUBAGENTS=0`. Full list in `.claude/references/grok-cli.md`.

## Code Conventions

- ES modules, `node:` prefixed built-in imports, no dependencies — ever, without explicit approval
- JSDoc type annotations on exported functions; `// @ts-check` at top of every `.mjs`
- Small pure functions in `scripts/lib/`; side effects (spawn, fs, git) at the edges so they're testable
- Errors: throw `Error` with actionable messages ("Run `grok login`"); entrypoint maps to exit codes
- Self-documenting code; comments only for non-obvious WHY (e.g., why a guard layer exists)
- Never use `§` in docs

## Skill Auto-Loading

**MANDATORY:** Load the matching skill BEFORE starting work when a trigger matches.

| Trigger | Skill / Agent | When |
|---|---|---|
| Plugin/command/marketplace/hook schema questions | `claude-code-guide` agent | Before writing any manifest or command frontmatter |
| Changing the grok invocation or guard | `security-review` | Any change to runner flags, env, fingerprint, or prompt wrapping |
| Unexpected CLI behavior | `superpowers:systematic-debugging` | Odd JSON, exit codes, sandbox errors |
| Claiming done | `superpowers:verification-before-completion` | Real end-to-end `grok` run + guardrail test + `node --test` |
| Code quality | `simplify` | After implementation, before commit |
| Git commits | `commit-commands:commit` | Every commit |
| Push + PR | `commit-commands:commit-push-pr` | After `/code-review` passes |
| Guardrail/security design | `superpowers:brainstorming` | Before changing any read-only layer |

## MCP Servers

None required. `context7` is not useful here — the `grok` CLI's source of truth is `~/.grok/docs/user-guide/` and `grok --help`.

## Cross-Cutting Recipes

- **Changing grok flags:** read `.claude/references/grok-cli.md` → change → adversarial guardrail test → update the reference file with what you verified.
- **Bug fixing:** `superpowers:systematic-debugging`; reproduce with a direct `grok` invocation first.
- **Claiming done:** `node --test "tests/**/*.test.mjs"` green + real `/grok:adversarial-review` run on a repo with a diff + guardrail test shows repo unchanged.

## Git Workflow

- Conventional commits (`feat:`, `fix:`, `refactor:`, `docs:`, `chore:`, `test:`)
- **MANDATORY:** `/commit` for ALL commits; `/commit-push-pr` for ALL push/PR operations
- Branch `{type}/{description}`; never commit directly to `main`
