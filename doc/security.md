# Security

Layers: Tailscale Serve/Funnel (HTTPS, no exposed ports) in front of single-user password auth — Argon2 hash in `PASSWORD_HASH` (base64), DB-backed sessions with 256-bit tokens, 7-day expiry, IP/user-agent audit, per-session revocation. Expired/revoked sessions stay listed for 30 days of audit, then `purgeInactiveAuthSessions` deletes them (at boot and on login) so the table stays bounded.

**GitHub token**: use a fine-grained PAT scoped to only the exposed repos, granting no more than the permissions the README lists; it's wired into each clone via a git credential helper.

Session isolation is convention-only and `bypassPermissions` is used — the machine must be dedicated to this app (see DESIGN.md).

## Input Sanitization

Untrusted text is scrubbed before it reaches the model using [`agent-sanitizer`](https://github.com/AlexanderMattTurner/agent-sanitizer) (hidden-content prompt injection: invisible Unicode, ANSI escapes, human-invisible HTML; plus advisory detection of exfil-shaped URLs and look-alike host names). Both seams live in [`src/server/services/input-sanitizer.ts`](../src/server/services/input-sanitizer.ts) and **fail open** — on any internal error the original content passes through rather than blocking the send.

- **Tool output (primary surface)** — the real injection vector is text the agent _pulls in_ (web fetches, issue bodies, MCP responses), not the operator's typed prompt. `sanitizeToolOutput` runs as a `PostToolUse` hook returning `updatedToolOutput`, substituted before the model sees the result. Because `tool_response` shapes are tool-specific and the SDK only honors a shape-preserving replacement, the sanitizer deep-walks the response and rewrites string leaves in place, substituting only when something actually changed.
- **User prompt (secondary surface)** — `sanitizeUntrustedInput` runs at the single `sendUserMessage` chokepoint. This mainly covers the genuinely untrusted case of an initial prompt embedding a GitHub issue body, which enters as a user message and would bypass the hook.

**Filtering is visible to both parties, but not to the same degree.** The hook returns `additionalContext` on any message the scanner produced — including the advisory findings that rewrite nothing, whose whole value is the sentence — so the agent is never scrubbed blind and knows how to recover exact bytes (`xxd`/`od -c`). That text is capped (`FINDING_TEXT_BUDGET`), and so is the copy that gets persisted and rendered — one bound, every consumer.

The operator sees less. Findings (`SanitizationInfo` in [`src/lib/sanitization.ts`](../src/lib/sanitization.ts), shared by server and client) are persisted on the affected message — directly for user prompts; for tool results a per-session map keyed by `tool_use_id` bridges to the `tool_result` message that arrives later from the stream (`attachToolResultSanitizations`). The client shows an amber `SanitizationBadge` with the warnings; purely informational, non-blocking.

Notes:

- Exfil-URL and confusable-host detection is advisory (reported, not rewritten).
- The library reports findings in two severity tiers (`warnings` and the quieter `notes`); we merge both into the messages we surface, because the decision to _badge_ keys off its `found` categories, which are severity-blind. Dropping `notes` would badge exfil-URL findings with no text explaining them.
- A note-tier finding carrying no category (a preserved `<script>`) reaches the agent and a `log.debug`, but is never persisted or badged — badging it would train the reader to skip the badge. Measured on 2.57.5, that class is one thing in practice ("scripting/resource content present and preserved"), firing on ~100% of real web pages and ~4% of this repo's own source files, nearly all inline `<svg>` in components. That first-party rate is the cost of not gating on provenance; the reasoning is at `sanitizeToolOutputHook`.
- This is defense-in-depth, not a hard boundary — without a sandbox/egress firewall it catches mistakes and obvious injection, not a determined adversary.
- The library is precision-favoring (deletion-only over a narrow payload-shaped set), so it rarely touches legitimate text.
- `FINDING_TEXT_BUDGET` is insurance against a shape real content doesn't take, not a fix for an observed problem. The library names every string it flags in one sentence, so a page of 1000 look-alike hosts would yield a single ~63k-character message — but measured across Hacker News, Wikipedia, a GitHub repo page and a 1.2MB Guardian homepage (three with rewrite-path findings), sanitized output ran 0.99-1.00x the input and the longest message was 487 characters. Resist bounding the rewrite path itself over this: truncating tool output to defend against an input no page produces trades a real failure for a hypothetical one.
- Pinned to an exact version and listed in `minimumReleaseAgeExclude` (it releases faster than the repo's 7-day supply-chain quarantine); the exact pin keeps an excluded auto-bump from slipping in unreviewed.
