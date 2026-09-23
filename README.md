# grok: adversarial code review for Claude Code

> **Unofficial.** Not affiliated with or endorsed by xAI.

A Claude Code plugin that runs **Grok** as a deep adversarial reviewer of your changes, using the official `grok` CLI and your **SuperGrok / X Premium+ subscription**. No API key is needed.

Grok is **strictly read-only**: it can read, list, and search your files, and nothing else. See [Read-only guarantee](#read-only-guarantee).

```
/grok:adversarial-review
/grok:adversarial-review --base main look hard at the retry logic
/grok:adversarial-review --model grok-4.7 --effort high --background
```

## Requirements

- Claude Code
- Node.js 22+
- Git
- The `grok` CLI, logged in with your subscription:
  - macOS / Linux: `curl -fsSL https://x.ai/cli/install.sh | bash`
  - Windows (PowerShell): `irm https://x.ai/cli/install.ps1 | iex`
  - then `grok login` and check with `grok models`

## Install

```
/plugin marketplace add cristian-robert/grokPlugin
/plugin install grok@grok-review
```

## Usage

`/grok:adversarial-review [--wait|--background] [--base <ref>] [--scope auto|working-tree|branch] [--model <id>] [--effort <level>] [focus ...]`

| Option | Meaning |
|---|---|
| *(no target)* | `auto`: reviews uncommitted changes if there are any, otherwise your branch against the default branch |
| `--base <ref>` | Review `HEAD` against the merge-base with `<ref>` |
| `--scope working-tree` / `branch` | Force one of the two targets |
| `--model <id>` | Skip the model picker. Without it, the command lists the models your account can use and asks you to pick |
| `--effort <level>` | Grok reasoning effort (default `high`): `none`, `minimal`, `low`, `medium`, `high`, `xhigh`, `max` |
| `--wait` / `--background` | Skip the "wait or background" question. Foreground reviews stop after 9 minutes; background reviews after 30 |
| `--timeout-minutes <n>` | Override the review time limit (1–120) |
| focus text | Anything else steers the review, e.g. `focus on auth and tenant isolation` |

### How deep it goes

Each review is two Grok runs. First Grok investigates with its read tools: it maps the scope and intent of the change, reads every changed file in full, traces callers, callees, and tests beyond the diff, attacks the change, and re-verifies each finding. Then the same Grok session converts its review into structured output. Reasoning effort defaults to `high` and there's no turn limit, so a review takes a few minutes even for small changes; background mode is recommended.

The review returns a verdict (`approve` / `needs-attention`), a ship/no-ship summary, and findings ranked by severity with `file:line`, confidence, and a concrete recommendation. Claude shows the output verbatim and does not fix anything.

## Read-only guarantee

No single mechanism is trusted on its own. Every review runs with all of these layers:

1. **Claude side:** the command removes Claude's `Edit`, `Write`, and `NotebookEdit` tools while it runs, pre-approves only this plugin's own script (no raw `git` or `node`), and treats Grok's output as untrusted data: Claude shows it and never acts on instructions inside it.
2. **Tool surface:** Grok gets exactly three tools: `read_file`, `grep`, `list_dir`. There is no shell, no file writing or editing, no web access, no MCP, and no subagents.
3. **Permissions:** `dontAsk` mode plus deny rules for `Write`, `Edit`, `Bash`, and every MCP tool.
4. **Isolation:** Grok normally imports your Claude/Cursor setup (instructions, MCP servers, hooks, and Claude *plugins*). Each review runs with an empty temporary `HOME`, every compatibility switch off, and only an allowlisted set of environment variables (no cloud credentials or tokens). Before each run, `grok inspect` lists anything still loaded (for example Grok-native plugins or a repo's `.mcp.json`); the review header shows it as a WARNING. Grok is told not to use MCP servers or plugins, and its tool list can't reach them anyway.
   - **Secrets:** Grok's read tools are denied on credential stores (`~/.grok`, `~/.ssh`, `~/.aws`, `~/.config`, `~/.claude`, …), and recursive searches rooted above the repo are blocked.
5. **Kernel sandbox:** `--sandbox read-only` on macOS (Seatbelt) and Linux (Landlock, kernel 5.13+).
6. **Integrity check:** the repository is fingerprinted before and after the run: HEAD, refs, index, `.git/HEAD`, `.git/config`, `.git/info/`, `.git/hooks/`, the bytes of every modified and untracked file, and the size and modification time of ignored files (e.g. `node_modules/`, `.env`). The plugin's own git calls pin `core.fsmonitor=false`, so a planted fsmonitor can't run during the check. Any difference prints **GUARDRAIL VIOLATION**, exits with code 3, and discards the review. Nothing is auto-reverted, so edits you make at the same time are never lost.
7. **Prompt:** Grok is told it is read-only and that repository content is data, not instructions.

The review header states which layers were active for that run.

### Known limits

- **Windows has no kernel sandbox** (Grok doesn't offer one). Layers 1–4, 6, and 7 still apply, and the header says `Kernel sandbox: NOT enforced`. End-to-end review on a real Windows machine hasn't been verified yet; unit tests run on Windows in CI.
- **Grok doesn't confirm sandbox enforcement** in headless mode, so on macOS/Linux the header says "requested, unconfirmed". Grok's built-in profiles fall back to running without the sandbox if the kernel refuses it.
- Repositories inside `/tmp`, `/var/tmp`, or `~/.grok` are writable even under the sandbox. The header says so, and the integrity check still applies.
- The integrity check can't tell Grok's writes apart from your own edits during the run, so don't edit the repo while a background review runs.
- Ignored files are compared by size and modification time, not content, and only the first 200,000 are checked (the header says when that limit is hit).
- In a folder you've trusted in Grok, the repo's own instructions, skills, and permission rules (e.g. `AGENTS.md`, `.grok/`, `.claude/settings.json`) are loaded. They can't add write access, but they could bias the review; the header shows a WARNING listing them.
- Hooks from Grok-native plugins you installed under `~/.grok` can still run during a review; the header warns when any are loaded.
- Grok can still read individual files outside the repo by exact path, apart from the denied credential stores.
- Other linked git worktrees aren't covered by the integrity check, and an untracked nested repository is compared as a directory, not by content.
- Grok's "leader" process mode is not used by headless reviews on this machine; that it can't be triggered on Windows (where no sandbox is requested) is unverified.

## Development

```bash
node --test "tests/**/*.test.mjs"             # unit + fake-grok integration tests (no subscription needed)
claude plugin validate ./plugins/grok --strict
claude --plugin-dir ./plugins/grok            # try the command locally
```

The scripts have zero npm dependencies. Verified facts about the `grok` CLI live in `.claude/references/grok-cli.md`.

## License

MIT. The review prompt and output schema are adapted from OpenAI's [Codex plugin for Claude Code](https://github.com/openai/codex-plugin-cc) (Apache-2.0); see [NOTICE](NOTICE).
