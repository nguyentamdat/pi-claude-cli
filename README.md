# pi-claude-cli

**Use your Claude Pro/Max subscription from the [pi coding agent](https://github.com/earendil-works/pi).** The official Claude Code CLI handles authentication and model access. pi owns the prompt, tools, conversation and compaction.

```bash
pi install npm:@saccolabs/pi-claude-cli
```

Pick a model under `claude-1` (or the compatible `pi-claude-cli` alias) with `/model`. The same default works in pi's terminal and [Phosphor](https://github.com/agustinsacco/Phosphor). No separate minimal mode or configuration is required.

Requires Node 22+, pi, and an authenticated `claude` binary on PATH (Claude Code 2.1.263+). Tested with pi 0.87.1 and Claude Code 2.1.280. Subscription credentials stay in the official CLI; no API key extraction.

## One owner: pi

- **Prompt:** pi's current system prompt replaces Claude Code's coding-agent prompt. A short binding explains the MCP tool-name prefix. Project instructions, skills and `.pi` paths remain unchanged; Claude does not independently discover them.
- **Tools:** only the current request's tools are advertised. All tools, including read/edit/bash, execute in pi through the authenticated MCP bridge. Normal pi tool hooks, schemas and complete results apply. The provider never enables inactive tools. Claude-native agents, planning, scheduling and web tools are not enabled.
- **Conversation:** pi's current history is authoritative. A warm Claude process is reused only while the acknowledged history prefix and launch configuration match. Edits, compaction, provider changes, prompt changes or tool changes cause a clean reimport.
- **Storage:** default Claude processes use `--no-session-persistence`. No new Claude conversation file, resume pairing or saved system-prompt sidecar is created. Private temporary prompt and MCP files are removed when no longer needed; the runtime directory is removed on process exit. A SIGKILL can leave its private temporary directory behind.
- **Compaction:** pi compacts its own history normally. CLI auto-compaction is disabled. Hosts must not switch off pi compaction just because this provider is selected.

## Claude accounts: one provider per account

Choose `claude-1/<model-id>` or `claude-2/<model-id>` with `/model`. Both expose the same static Anthropic model catalog. `pi-claude-cli/<model-id>` remains an alias of `claude-1` for existing settings, fallback chains and host model choices.

Each provider reads its own `<agentDir>/claude-accounts/<name>.json`, where `agentDir` is nonempty `$PI_CODING_AGENT_DIR` or `~/.pi/agent`, and `name` is `claude-1` or `claude-2`:

```json
{ "env": { "CLAUDE_CODE_OAUTH_TOKEN": "<your account token>" } }
```

Alternatively use `{"env":{"CLAUDE_CONFIG_DIR":"/absolute/existing/profile"}}` for an already authenticated official CLI profile. These are the only allowed env keys; values must be nonempty strings, and the file must contain only the `env` object. Token files must be owned by the current user and have mode **0600** (`chmod 600`). Symlinked account files are supported: target permissions/ownership are checked. Dangling symlinks, invalid JSON and unsupported keys fail with secret-free errors.

Missing `claude-1.json` uses native default login, with inherited `CLAUDE_CONFIG_DIR` and `CLAUDE_CODE_OAUTH_TOKEN` removed from the child env. Missing/invalid `claude-2.json` fails that provider's requests, never silently using account1. Explicit token files pass the token directly to the child CLI. Pi's `process.env` is never changed. Files are read at **spawn time**: edits apply to new CLI processes; an existing warm process retains its account. Pools are isolated per provider/account and reuse acknowledged history within an account.

Configured files fail closed if conflicting inherited API-key/auth-token overrides, OAuth/API-key file descriptors, alternate-cloud flags or `CLAUDE_SECURESTORAGE_CONFIG_DIR` are set. Errors name only those variables, never their values; unset them before using a configured account. Missing-file `claude-1` keeps its native login behavior.

`/claude-account` (also `status` or `list`) is **read-only**: it lists provider sources, whether a token is present, and config directories, never token values or authenticated identities. The old session-local selection command and `claude-accounts.json` map are no longer used. Select accounts through `/model` instead.

**Manual-default contamination:** native `claude-1` can follow `CLAUDE_CODE_OAUTH_TOKEN` in `~/.claude/settings.json` (or the selected profile's `settings.json`), for example after an external host's manual-default switch. Status reports **“claude-1 follows manual default token from settings.json”** without exposing the token. This provider never modifies settings.json. To pin account1 independently of that manual default, configure its own token file. Host/managed guards and official CLI authentication remain in force.

Quota notices and rejected rate-limit diagnostics become assistant errors with `stopReason: "error"` and `errorMessage` containing `rate limit`, retaining the provider id and diagnostics. This is the provider-independent signal recognized by `pi-model-fallback`; configure that extension's chain as `claude-1/<model-id>` → `claude-2/<model-id>` → `openai-codex/<model-id>`. The provider itself does not switch models or retry across accounts. Independent host `/quota` monitors may still describe the native account rather than the selected provider.

### Optional terminal wrappers

Run `node scripts/install-claude-wrappers.mjs --dry-run` to preview, then without `--dry-run` to install `claude-1` and `claude-2` shell wrappers. Use `--bin-dir /your/bin` to override `~/.local/bin`. Existing targets are refused, not overwritten. No account file is read at installation and no token is embedded. Each invocation reads and validates the same account files (including symlink targets), sets child-only credentials, and execs the absolute real `claude` resolved from PATH at installation. Keep this package installed at its current location; reinstall wrappers if its location or the real CLI path changes. These wrappers are for POSIX shells, not Windows command prompts.

## Switching providers

Claude → native pi → Claude uses the same pi session. Switching models retires the parked Claude process and clears its UI status. Switching back imports pi's current context, including native-provider turns, full tool results and images. Branch navigation and compaction cannot resume a stale Claude transcript.

A fresh CLI process costs a history import and may lose the previous prompt cache. Ordinary follow-ups and tool handoffs keep the warm process; pi does not resend history on each tool call.

**Not byte-identical to a direct API provider:** Claude Code's print interface accepts user messages, not an arbitrary structured conversation. Imports preserve message order and content using role-labelled text plus image blocks. Historical tool calls are records, not re-executed operations. Claude's internal runtime and service policies still apply.

For sessions created before 0.9.0, the next default call detaches the old resume pairing and imports pi's context automatically. Old Claude transcripts are retained as archives, never resumed by the default path. Missing information in old marker-only pi records cannot be recreated; new sessions record normal pi tool calls and results.

## Host integration

See [the context contract](docs/CONTEXT-POLICY.md).

- Keep pi's project/skill discovery and auto-compaction enabled.
- Use pi's normal tool and transcript UI. Historical `[Claude Code · ...]` markers remain readable for old sessions.
- Explicit host hooks supplied with `PI_CLAUDE_CLI_SETTINGS` and managed Claude policy remain in force. Do not use `--bare`: it disables subscription authentication and hooks.
- The `claude-rate-limit` status reports subscription state outside conversation content.
- One-shot hosts should set `PI_CLAUDE_CLI_KEEPALIVE_MS=0` so a parked process does not delay exit, and `PI_CLAUDE_CLI_EPHEMERAL=1` so a run on the legacy path leaves nothing behind either.

## Configuration

The defaults above require no environment variables.

| Variable                         | Default      | Purpose                                              |
| -------------------------------- | ------------ | ---------------------------------------------------- |
| `PI_CLAUDE_CLI_KEEPALIVE_MS`     | `600000`     | Idle process lifetime; `0` for one-shot runs         |
| `PI_CLAUDE_CLI_SETTINGS`         | unset        | Explicit host Claude settings, including guard hooks |
| `PI_CLAUDE_CLI_TIMEOUT_MS`       | `300000`     | Maximum stdout inactivity                            |
| `PI_CLAUDE_CLI_HANDOFF_WAIT_MS`  | `1800000`    | Maximum wait for pi tool execution                   |
| `PI_CLAUDE_CLI_THINKING_DISPLAY` | `summarized` | `omitted` returns no thinking summaries              |
| `MCP_TOOL_TIMEOUT`               | `3600000`    | CLI MCP call timeout                                 |

`PI_CLAUDE_CLI_CONTEXT=pi` explicitly selects the default. `legacy` retains the old observer behavior for compatibility, with native Claude tools, a separate persistent transcript and CLI-owned compaction. `PI_CLAUDE_CLI_SYSTEM_PROMPT`, `PI_CLAUDE_CLI_AUTOCOMPACT`, `PI_CLAUDE_CLI_TOOL_RESULTS`, `PI_CLAUDE_CLI_HERMETIC` and `PI_CLAUDE_CLI_STRICT_MCP` configure that legacy path; they do not weaken pi ownership in the default path. [Legacy architecture and wire contracts](docs/ARCHITECTURE.md).

`PI_CLAUDE_CLI_EPHEMERAL=1` is for one-shots such as `pi -p --no-session` (session naming, health checks). On the legacy path it spawns the CLI with `--no-session-persistence` and records no resume pairing or stored system prompt, as the default already does. Do not switch it on part-way through a persisted legacy session: the CLI would not record those turns, and a later resume would silently miss them.

## Development

```bash
npm ci
npm run typecheck
npm run lint
npm run format:check
npm run test:coverage
npm run test:e2e
```

The test suite retains explicit legacy fixtures and adds default-policy tests for tool selection, prompt changes, branch/compaction resets, provider round-trips, images, errors and cleanup.

The opt-in real-CLI check spends subscription tokens in a disposable workspace:

```bash
PI_OWNED_LIVE=1 npx vitest run tests/live-context-policy.test.ts tests/live-pi-roundtrip.test.ts tests/live-thinking.test.ts
```

The isolated CLI check verifies read/custom-tool handoffs, host hooks, discovery isolation, warm follow-ups and absence of a saved Claude transcript. The real-pi RPC check executes read/edit, enforces a pi tool guard, switches through a deterministic native provider, then compacts pi and checks recall. The thinking check changes pi's thinking level between turns on Haiku 4.5 and Sonnet 5, and during a tool call, and reads each request's `thinking` and effort through a local proxy to confirm every turn ran at the chosen level on one CLI process. These checks do not measure coding-quality parity.

pi's thinking levels reach the model as the request pi's own Anthropic provider would send: `off` disables thinking, other levels send pi's budget (Haiku 4.5, Opus 4.5, Sonnet 4.5) or effort (adaptive models) with thinking summaries. A level changed mid-session applies from the next turn without restarting the CLI. Each model offers pi's own levels for it, less `minimal` on adaptive models (where it equals `low`). Details: [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md#thinking-the-same-request-pi-would-send-0100).

## License

MIT
