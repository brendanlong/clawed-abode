# Security

Layers: Tailscale Serve/Funnel (HTTPS, no exposed ports) in front of single-user password auth — Argon2 hash in `PASSWORD_HASH` (base64), DB-backed sessions with 256-bit tokens, 7-day expiry, IP/user-agent audit, per-session revocation.

**GitHub token**: use a fine-grained PAT scoped to only the exposed repos with just "Contents: Read and write"; it's wired into each clone via a git credential helper.

Session isolation is convention-only and `bypassPermissions` is used — the machine must be dedicated to this app (see DESIGN.md).

## Input Sanitization

Untrusted text is scrubbed before it reaches the model using [`agent-input-sanitizer`](https://github.com/alexander-turner/agent-input-sanitizer) (hidden-content prompt injection: invisible Unicode, ANSI escapes, human-invisible HTML; plus advisory detection of exfil-shaped URLs). Both seams live in [`src/server/services/input-sanitizer.ts`](../src/server/services/input-sanitizer.ts) and **fail open** — on any internal error the original content passes through rather than blocking the send.

- **Tool output (primary surface)** — the real injection vector is text the agent _pulls in_ (web fetches, issue bodies, MCP responses), not the operator's typed prompt. `sanitizeToolOutput` runs as a `PostToolUse` hook returning `updatedToolOutput`, substituted before the model sees the result. Because `tool_response` shapes are tool-specific and the SDK only honors a shape-preserving replacement, the sanitizer deep-walks the response and rewrites string leaves in place, substituting only when something actually changed.
- **User prompt (secondary surface)** — `sanitizeUntrustedInput` runs at the single `sendUserMessage` chokepoint. This mainly covers the genuinely untrusted case of an initial prompt embedding a GitHub issue body, which enters as a user message and would bypass the hook.

**Filtering is visible to both parties.** The hook returns `additionalContext` telling the agent hidden content was removed and how to recover exact bytes if needed (re-read via `xxd`/`od -c`) — otherwise the agent is scrubbed blind. Findings (`SanitizationInfo` in [`src/lib/sanitization.ts`](../src/lib/sanitization.ts), shared by server and client) are persisted on the affected message — directly for user prompts; for tool results a per-session map keyed by `tool_use_id` bridges to the `tool_result` message that arrives later from the stream (`attachToolResultSanitizations`). The client shows an amber `SanitizationBadge` with the warnings; purely informational, non-blocking.

Notes:

- Exfil-URL detection is advisory (logged, not rewritten).
- This is defense-in-depth, not a hard boundary — without a sandbox/egress firewall it catches mistakes and obvious injection, not a determined adversary.
- The library is precision-favoring (deletion-only over a narrow payload-shaped set), so it rarely touches legitimate text.
- Pinned to an exact version and listed in `minimumReleaseAgeExclude` (it releases faster than the repo's 7-day supply-chain quarantine); the exact pin keeps an excluded auto-bump from slipping in unreviewed.
