# Settings

Layers and merging: [`src/server/services/settings-merger.ts`](../src/server/services/settings-merger.ts); shared schemas/encryption in [`settings-helpers.ts`](../src/server/services/settings-helpers.ts); routers in [`globalSettings.ts`](../src/server/routers/globalSettings.ts) / [`repoSettings.ts`](../src/server/routers/repoSettings.ts).

## Resolution Rules

- **Claude model**: session → repo → global → `CLAUDE_MODEL` env (`resolveClaudeModel`). The per-session override lives on `Session.claudeModel` (set at create or via `sessions.setModel`, the gear button in the session header).
- **Env vars / MCP servers**: global entries apply everywhere; a per-repo entry with the same name wins.
- **System prompt**: base (default, or the override if enabled) + global append + per-repo append, in that order.
- **Setting sources**: global-only toggles for the SDK's `user` / `project` / `local` filesystem scopes (`resolveSettingSources`, default: only `project`). Widening is a **trust decision** — these scopes load hooks (which execute) and permissions. A settings-file `PostToolUse` hook merges with, not displaces, the app's sanitizer hook (verified by `scripts/spike-hook-merge.ts`).

## Advisor Model

Global-only and **opt-in**: null means the advisor tool isn't wired into requests at all; setting a model enables it. `SUGGESTED_ADVISOR_MODEL` ([`src/lib/advisor.ts`](../src/lib/advisor.ts), dependency-free so server and client share it) is what an empty Enable→Save adopts — it is _not_ a resolution fallback; only the Disable button reaches the disabled state. There's no dedicated SDK option, so it's passed as an ad-hoc `--settings` source via `Options.extraArgs` (omitted entirely when disabled). The SDK is pinned to an exact version because earlier ones silently ignore `advisorModel`; to re-verify after a bump, capture the CLI's outgoing `/v1/messages` request and check the `tools` array for `advisor_20260301`.

## Secrets

Values marked secret are encrypted at rest (AES-256-GCM with `ENCRYPTION_KEY`, [`src/lib/crypto.ts`](../src/lib/crypto.ts)), masked in the UI, and decrypted only when establishing a query. The global Claude API key override is never exposed to the UI — only a "configured" flag.

**MCP secrets never touch the CLI argv.** Setting the SDK's `options.mcpServers` serializes the config inline as `--mcp-config '<json>'` on the argv, which leaks tokens into journald and world-readable `/proc/<pid>/cmdline`. Instead `buildSdkOptions` writes the merged config to a mode-`0600` `mcp-config.json` in the session workspace (sibling of the clone, removed with the workspace on archive) and passes `--mcp-config <path>` via `extraArgs` ([`src/server/services/mcp-config-file.ts`](../src/server/services/mcp-config-file.ts)). The file is rewritten on each establishment (self-heals deletion, picks up changes) and removed when the session has no MCP servers so a stale secret-bearing file can't linger. Live mid-session MCP changes go through `query.setMcpServers` (a stdin control message) and never touch argv.

## Live vs Restart-Bound

Settings bind when the query is established. **Model and MCP servers** re-apply live on the next send when changed (`query.setModel` / `query.setMcpServers`; `sessions.setModel` also refreshes an idle query immediately). **Env vars, system prompt, advisor model, and setting sources** have no live SDK setter and take effect only after Stop→Start.
