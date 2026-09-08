# Settings

Loading and merging: [`src/server/services/settings-merger.ts`](../src/server/services/settings-merger.ts); shared schemas/encryption in [`settings-helpers.ts`](../src/server/services/settings-helpers.ts); routers in [`globalSettings.ts`](../src/server/routers/globalSettings.ts) / [`repoSettings.ts`](../src/server/routers/repoSettings.ts).

Env vars and MCP servers are **scope-generic**: one table each, `repoSettingsId` null for global and a RepoSettings id for per-repo. [`settings-scope.ts`](../src/server/services/settings-scope.ts) implements every operation once over a `SettingsScope`, and [`scoped-settings.ts`](../src/server/routers/scoped-settings.ts) produces the identical set-/delete-/reveal-/validate- procedures for both routers. Writes are single `INSERT … ON CONFLICT` statements (the global uniqueness is a partial index Prisma's `upsert` can't target), with "empty secret means unchanged" decided inside the statement — never read-then-branch.

## Resolution Rules

- **Claude model**: session → repo → global → `CLAUDE_MODEL` env (`resolveClaudeModel`). The per-session override lives on `Session.claudeModel` (set at create or via `sessions.setModel`, the gear button in the session header).
- **Env vars / MCP servers**: global entries apply everywhere; a per-repo entry with the same name wins.
- **System prompt**: base (default, or the override if enabled) + global append + per-repo append, in that order.
- **Rate-limit pause**: session → global, with the two fields (on/off, threshold) resolving independently so a session can raise its threshold without restating the global on/off (`resolvePausePolicy`; there is no repo layer). Applies immediately, not at the next establishment. See [`rate-limit-pause.md`](rate-limit-pause.md).
- **Setting sources**: global-only toggles for the SDK's `user` / `project` / `local` filesystem scopes (`resolveSettingSources`, default: only `project`). Widening is a **trust decision** — these scopes load hooks (which execute) and permissions. A settings-file `PostToolUse` hook merges with, not displaces, the app's sanitizer hook (verified by `scripts/spike-hook-merge.ts`).

## Advisor Model

Global-only and **opt-in**: null means the advisor tool isn't wired into requests at all; setting a model enables it. `SUGGESTED_ADVISOR_MODEL` ([`src/lib/advisor.ts`](../src/lib/advisor.ts), dependency-free so server and client share it) is what an empty Enable→Save adopts — it is _not_ a resolution fallback; only the Disable button reaches the disabled state. There's no dedicated SDK option, so it's passed as an ad-hoc `--settings` source via `Options.extraArgs` (omitted entirely when disabled). SDK versions before 0.3.196 silently ignore `advisorModel`; to re-verify after a bump, capture the CLI's outgoing `/v1/messages` request and check the `tools` array for `advisor_20260301`.

## MCP Validation

The Validate button connects with the MCP SDK and lists tools. HTTP/SSE servers are contacted directly (with a fresh OAuth token when they use one); stdio servers are spawned on the host with the MCP SDK's minimal default environment plus their own decrypted env (never the app's `process.env`, which holds the encryption key and tokens) and killed after the check (15s timeout).

## MCP OAuth

An http/sse server's `authType` is `headers` (a static secret) or `oauth`. OAuth exists because a growing class of remote servers offers **no static credential at all**, and it is exactly the read-only tiers that are gated behind it (Google Calendar's MCP server is OAuth-only; Todoist's `data:read` scope has no personal-token equivalent).

The grant is a `McpOAuth` row per `McpServer` row — so a global and a per-repo entry for the same remote server hold independent grants, and deleting the server deletes the grant. Client secret, tokens and the in-flight PKCE verifier are encrypted with `ENCRYPTION_KEY`; choosing `oauth` therefore requires encryption to be configured.

Connect runs entirely server-side except the `/authorize` step ([`mcp-oauth.ts`](../src/server/services/mcp-oauth.ts), discovery in [`mcp-oauth-discovery.ts`](../src/server/services/mcp-oauth-discovery.ts), pure URL rules in [`src/lib/mcp-oauth-urls.ts`](../src/lib/mcp-oauth-urls.ts)):

1. **Discovery** degrades one step at a time, because remote servers publish inconsistently: the `resource_metadata` pointer in the MCP endpoint's 401 → the RFC 9728 well-known locations → RFC 8414/OIDC authorization-server metadata → origin-root endpoints. Both well-known lookups try the **path-inserted** location first (RFC 9728 §3.1 / RFC 8414); the root one is only authoritative for a bare-origin resource, and deriving it wrong is the single most common way this flow dies silently.
2. **Client acquisition**: reuse a client the user typed or one we registered against the same issuer, else dynamic client registration. `token_endpoint_auth_method: "none"` is requested only when the server advertises it. **A manually entered client ID is the escape hatch** and is not optional polish — Google and Microsoft Entra have no DCR at all.
3. **Authorize** in the user's browser with PKCE S256 and the RFC 8707 `resource` indicator.
4. **Callback** at `/api/mcp/oauth/callback` (see [`security.md`](security.md)), which exchanges the code and stores the tokens.

The access token is refreshed on demand and injected as an `Authorization` header by `applyMcpOAuthHeaders`, **after** global/per-repo merging so a shadowed server never spends a refresh. The token columns ride along with the server row, so an unexpired token costs no extra query on a path that runs on every send. It flows through the same mode-0600 `mcp-config.json` as every other MCP secret. Refreshes are coalesced per credential (a rotating refresh token is single-use, and several sessions can establish at once). A refusal that means the grant is dead (`invalid_grant`), or an expiry with no refresh token to spend, clears the tokens so the UI shows "needs re-authorization"; anything else keeps them for the next attempt and reports the failure alongside the still-valid grant. When no token can be produced the server is still passed to the agent, just without the header — the session doesn't fail over one broken connector.

The redirect URI is derived from the **request's** origin (`APP_URL` overrides), never loopback: the app is headless and the browser is on another device. The settings form shows the exact value from `globalSettings.getMcpOAuthRedirectUri` rather than the browser's own origin, because those differ whenever `APP_URL` is set and a mismatched `redirect_uri` is rejected outright.

Tokens are bound to a resource _and_ a client, so changing the server URL, changing a manually entered client ID, or registering a new client because the issuer moved all discard the stored grant rather than leaving a refresh token that can only earn an `invalid_grant`. Discovered endpoints are scheme-checked (`new URL()` parses `javascript:`, and the authorization endpoint is what the browser gets navigated to).

## Secrets

Values marked secret are encrypted at rest (AES-256-GCM with `ENCRYPTION_KEY`, [`src/lib/crypto.ts`](../src/lib/crypto.ts)), masked in the UI, and decrypted only when establishing a query. The global Claude API key override is never exposed to the UI — only a "configured" flag.

**MCP secrets never touch the CLI argv.** Setting the SDK's `options.mcpServers` serializes the config inline as `--mcp-config '<json>'` on the argv, which leaks tokens into journald and world-readable `/proc/<pid>/cmdline`. Instead `buildSdkOptions` writes the merged config to a mode-`0600` `mcp-config.json` in the session workspace (sibling of the clone, removed with the workspace on archive) and passes `--mcp-config <path>` via `extraArgs` ([`src/server/services/mcp-config-file.ts`](../src/server/services/mcp-config-file.ts)). The file is rewritten on each establishment (self-heals deletion, picks up changes) and removed when the session has no MCP servers so a stale secret-bearing file can't linger. Live mid-session MCP changes go through `query.setMcpServers` (a stdin control message) and never touch argv.

## Live vs Restart-Bound

Settings bind when the query is established. **Model and MCP servers** re-apply live on the next send when changed (`query.setModel` / `query.setMcpServers`; `sessions.setModel` also refreshes an idle query immediately). **Env vars, system prompt, advisor model, and setting sources** have no live SDK setter and take effect only after Stop→Start. The **rate-limit pause** settings aren't SDK options at all — they're evaluated server-side per send, so they apply at once.
