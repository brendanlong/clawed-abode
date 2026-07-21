# Messages & Real-Time Streaming

## Classification

Every SDK message routes through `classifyMessage` ([`src/lib/claude-messages.ts`](../src/lib/claude-messages.ts)) → `stream_event` | `skip` | `persist`. It switches over the SDK's `SDKMessage` union and ends in `assertNeverFallback`: a new top-level message type fails the build until handled, while at runtime an unrecognized type degrades to generic system persistence so an unexpected frame never crashes the query loop.

`system` subtypes fall into three buckets (not compile-time exhaustive; unknown subtypes get a safe default):

1. **Ignored** (never persisted): pure progress ticks (`thinking_tokens`, `task_progress`, `api_retry`, …) — `IGNORED_SYSTEM_SUBTYPES`.
2. **Visible**: `error`, `compact_boundary`, `model_refusal_fallback` — these carry signal. `model_refusal_fallback` marks a silent primary→fallback model downgrade after an API refusal; without a visible banner the downgrade would be invisible.
3. **Hidden**: everything else is **persisted but not rendered** (`isHiddenSystemMessage` gates both the list filter and the bubble render). Persisting keeps the option of widening the visible set later without a backfill.

Other rendering-relevant classification: `server_tool_use` (e.g. the advisor, which runs inside the API and never passes `canUseTool`) renders as a one-line indicator; a message whose only block is an encrypted `advisor_tool_result` is hidden (nothing human-readable to show). Thinking blocks are accumulated from `thinking_delta`s, rendered as one collapsed section, and excluded from copy/voice output.

## Storage & Pagination

Messages carry a per-session monotone `sequence`. **Every insert goes through `insertMessage`** ([`claude-runner.ts`](../src/server/services/claude-runner.ts)), which reserves a sequence with a single autocommit `UPDATE "Session" SET "messageSequence" = "messageSequence" + 1 … RETURNING` — one statement, so SQLite serializes it on the write lock and concurrent inserts can't collide. No read-then-insert, no retry loop, and no interactive transaction (those contend and deadlock under SQLite's single-writer model).

A duplicate `id` (e.g. an idempotent synthetic `tool_result`) fails the primary key and is treated as a no-op; the reserved sequence is skipped, leaving a gap — pagination orders by `sequence` and never assumes contiguity. All history queries are cursor-based on `sequence` (`claude.getHistory`, direction before/after).

## SSE

All server→client updates flow over SSE via tRPC's `httpSubscriptionLink` (client→server is plain mutations). Because the link opens one `EventSource` per subscription, the app uses exactly **two streams**:

1. **Per-session multiplexed stream** (`sse.onSessionEvents`) — a discriminated union of every event kind (`message`, `running`, `commands`, `pr`, `session`, `retry`, `background`, `queued`), folded from the in-process emitters in [`events.ts`](../src/server/services/events.ts). Client side, `useSessionStream` is mounted once per session page and fans events to the React Query caches (message merge: pure `mergeMessageIntoCache`). The query hooks are read/mutate-only and never open their own subscriptions.
2. **Global session-list stream** (`sse.onSessionListEvents`) — session changes, turn-state flips, and background-set flips all fan here; any event just triggers a `sessions.list` refetch, which carries the authoritative `turnActive` / `backgroundActive`, so reload/tab-switch/reconnect resync to the server's in-memory truth rather than trusting streamed state. It also carries `claude_finished` for the work-complete notifier (see [`claude-sessions.md`](claude-sessions.md)). The session-list badge derives running / background / waiting from the two axes (`deriveSessionDisplayStatus`); a dedicated `claude_background` signal covers background-set flips that produce no `running`/`finished` edge (a task settling with no continuation, or a ✕-stop).

**Resume.** The subscription input is stable — `{ sessionId, afterSequence }` with `afterSequence` frozen when history first loads (feeding the live newest sequence would tear the `EventSource` down every turn). Each event is wrapped in `tracked()` with a `watermark:counter` id ([`src/lib/sse-resume.ts`](../src/lib/sse-resume.ts)):

- `watermark` = highest **persisted** message sequence yielded; on (re)connect the server replays `sequence > floor` (the `lastEventId` watermark, or the initial `afterSequence`, which closes the gap between the history snapshot and the stream attaching). Partials and latest-value events never advance it — they're refetched on reconnect (`useRefetchOnReconnect`) instead of replayed.
- `counter` = strictly increasing per connection, seeded from the previous `lastEventId`, so ids never repeat across reconnects (tRPC drops repeated tracked ids).

`EventSource` auto-reconnects with `Last-Event-ID`; a `ConnectionStatusIndicator` banner shows while the stream is down. Ping/reconnect tuning lives in [`src/server/trpc.ts`](../src/server/trpc.ts).

## Rendering

Message display components and their rules (hidden system messages, tool-call density, subagent grouping/relocation) are documented in [`src/components/CLAUDE.md`](../src/components/CLAUDE.md).
