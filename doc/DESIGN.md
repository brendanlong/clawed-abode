# Clawed Abode - Design Document

## Overview

A self-hosted web application that provides mobile-friendly access to Claude Code running on local machines with GPU support. The system exposes Claude Code sessions through a web interface, with persistent sessions using separate git clones for isolation.

The system runs **directly on the host** without containers:

- **Separate git clones** provide session isolation — each session gets its own clone at `/worktrees/{sessionId}/`
- **Claude Agent SDK** runs in-process in the Next.js server — no per-session child processes or IPC
- **Native GPU access** — agents use the host's GPU directly
- **Host tools** — agents use whatever development tools are installed on the host

## Goals

- Run Claude Code sessions from mobile devices without a terminal
- Access local GPU resources not available in Claude Code Web
- Persistent sessions that survive disconnections
- Clean session lifecycle tied to git clones
- Secure access without VPN

## Architecture

```
┌─────────────────┐     ┌─────────────────┐     ┌──────────────────────────────────┐
│   Mobile/Web    │     │   Tailscale     │     │        Home Server               │
│   Browser       │────►│  Serve/Funnel   │────►│  ┌────────────────────────┐      │
│                 │     │                 │     │  │    Next.js + tRPC      │      │
└─────────────────┘     └─────────────────┘     │  │    - Auth              │      │
                                                │  │    - Session mgmt      │      │
                                                │  │    - Claude Agent SDK  │      │
                                                │  │    - SSE to browser    │      │
                                                │  │    - Git clone mgmt    │      │
                                                │  └────────────────────────┘      │
                                                │                                  │
                                                │  /worktrees/{sessionId}/          │
                                                │  /data/db/ - SQLite               │
                                                └──────────────────────────────────┘
```

## Data Model

The database schema is defined in [`prisma/schema.prisma`](../prisma/schema.prisma). Key models:

- **Session**: Claude Code sessions tied to git clones or standalone workspaces. `repoUrl` and `branch` are nullable — when null, the session has no repository (workspace-only).
- **Message**: Chat messages with sequence numbers for cursor-based pagination
- **AuthSession**: Login sessions with tokens and audit info
- **GlobalSettings**: Global application settings (system prompt override and append, Claude model, advisor model, Claude API key, TTS speed, voice auto-send)
- **RepoSettings**: Per-repository settings (favorites, custom system prompt, Claude model override)
- **EnvVar**: Environment variables for a repository or global (encrypted if secret). When `repoSettingsId` is null, the variable is global and applies to all sessions.
- **McpServer**: MCP server configurations for a repository or global. When `repoSettingsId` is null, the server is global and applies to all sessions.

### Session Archiving

When a session is deleted, it is archived rather than permanently removed. This preserves the message history for later viewing. Archived sessions:

- Have status set to `archived` and archivedAt timestamp recorded
- Have their workspace directory removed
- Keep all messages in the database for viewing
- Are excluded from the session list by default (toggle available to show them)
- Are read-only: no start/stop controls, no prompt input

### Data Storage

The system uses **host filesystem directories**:

1. **Database** (`/data/db/`): SQLite database.

2. **Session Workspaces** (`/worktrees/{sessionId}/{repoName}`): Each session gets its own git clone. Provides filesystem isolation between sessions.

### Workspace Structure

Each session's clone is at `/worktrees/{sessionId}/{repo-name}`. For no-repo sessions, just `/worktrees/{sessionId}/`.

The clone is the agent's working directory. Each session is fully isolated.

## API Design (tRPC)

### Authentication

Single-user authentication using password stored in `PASSWORD_HASH` environment variable (base64-encoded Argon2 hash).

```typescript
auth.login({ password })
  → { token }

auth.logout()
  → { success: true }

auth.logoutAll()
  → { success: true }
  // Deletes all sessions

auth.listSessions()
  → { sessions: AuthSession[] }
  // View all login sessions with IP/user agent

auth.deleteSession({ sessionId })
  → { success: true }
  // Revoke a specific session
```

### GitHub Integration

```typescript
github.listRepos({ search?: string, cursor?: string })
  → { repos: Repo[], nextCursor?: string }

github.listBranches({ repoFullName: string })
  → { branches: Branch[], defaultBranch: string }

github.listIssues({
  repoFullName: string,
  search?: string,
  state?: 'open' | 'closed' | 'all',  // default: 'open'
  cursor?: string,
  perPage?: number
})
  → { issues: Issue[], nextCursor?: string }
  // Lists issues for a repository with optional search and pagination

github.getIssue({ repoFullName: string, issueNumber: number })
  → { issue: Issue }
  // Get full details of a specific issue
```

### Session Management

```typescript
sessions.create({
  name: string,
  repoFullName?: string,   // e.g., "brendanlong/math-llm" — omit for no-repo sessions
  branch?: string,         // omit for no-repo sessions
  initialPrompt?: string   // Optional prompt to auto-send when session starts
})
  → { session: Session }
  // Returns immediately with session in "creating" status
  // Cloning continues in background (skipped for no-repo sessions)
  // UI polls session.get() to track progress via statusMessage
  // If initialPrompt is provided, it is sent automatically server-side when session becomes running

sessions.list({ status?: SessionStatus })
  → { sessions: Session[] }

sessions.get({ sessionId: string })
  → { session: Session }

sessions.start({ sessionId: string })
  → { session: Session }
  // Marks session as running (workspace already exists on disk)

sessions.stop({ sessionId: string })
  → { session: Session }
  // Stops any running Claude query, marks session as stopped

sessions.delete({ sessionId: string })
  → { success: true }
  // Stops query, removes workspace, archives session
```

### Claude Interaction

```typescript
claude.send({ sessionId: string, prompt: string })
  → { success: true }
  // Starts a query() call in-process using the Claude Agent SDK
  // Messages stream to the client via SSE

claude.answerQuestion({
  sessionId: string,
  toolUseId: string,                    // the AskUserQuestion tool_use block id
  answers: Record<string, string>
})
  → { success: true, routed: 'live' | 'fallback' | 'already' }
  // Delivers answers to an AskUserQuestion tool call. The server decides how
  // (see "Answering Interactive Tools" below): resolve the live canUseTool
  // promise, or — if the query has ended — resume with a new turn.

claude.respondToPlan({
  sessionId: string,
  toolUseId: string,                    // the ExitPlanMode tool_use block id
  approve: boolean,
  feedback?: string                     // revision notes (used when approve=false)
})
  → { success: true, routed: 'live' | 'fallback' | 'already' }
  // Approve or request changes to an ExitPlanMode plan, routed the same way
  // as answerQuestion.

claude.interrupt({ sessionId: string })
  → { success: boolean }
  // Interrupts the current turn (no-op if no main-agent turn is active). The
  // streaming query stays alive and is reusable for the next turn.

claude.getBackgroundTasks({ sessionId: string })
  → { tasks: BackgroundTask[] }
  // Running background tasks (run_in_background subagents / Monitor / backgrounded
  // Bash). Seeds the indicator; kept live by the `background` SSE channel.

claude.stopBackgroundTask({ sessionId: string, taskId: string })
  → { success: boolean }
  // Stops a single background task via query.stopTask, then optimistically
  // removes it from the live set (so the ✕ works even on a phantom whose
  // terminal task_notification was dropped). Idempotent: success means the
  // post-condition holds (task not in the live set for a session we could act
  // on), so a double-click / already-settled stop also returns true; false
  // only when there is no live session state. The background SSE event fires
  // only when an entry was actually removed.

claude.getHistory({
  sessionId: string,
  cursor?: number,        // sequence number
  direction: 'before' | 'after',
  limit?: number          // default 50
})
  → { messages: Message[], nextCursor?: number, hasMore: boolean }
```

## Session Lifecycle

### Creation Flow

1. User selects repo and branch from UI (or "No Repository" for workspace-only sessions)
2. Server calls `sessions.create()`
3. Server creates session record with status `creating` and returns immediately
4. UI navigates to session page, polls for status updates
5. **For repo sessions**: Background: Server clones the repository to `/worktrees/{sessionId}/{repoName}`
   **For no-repo sessions**: Background: Server creates an empty directory at `/worktrees/{sessionId}/`
6. Session status → `running`, statusMessage → null
7. Background: If an initial prompt was provided, server sends it via `sendUserMessage()` (no client interaction needed)

### Interaction Flow

1. User sends prompt via `claude.send()`
2. The server ensures the session's long-lived streaming `query()` exists (establishing it with `resume` if needed) and pushes the prompt into its input channel — see [Query Model](#query-model)
3. The `canUseTool` callback handles:
   - **AskUserQuestion** / **ExitPlanMode**: Parks a promise keyed by the SDK's `toolUseID`, sends the question/plan to the browser via SSE (as a normal assistant message with a `tool_use` block). The user responds via `claude.answerQuestion()` / `claude.respondToPlan()` (see [Answering Interactive Tools](#answering-interactive-tools)).
   - **All other tools**: Auto-approved (bypass permissions mode).
4. Messages stream from the SDK:
   - **Partial messages**: `stream_event` messages are accumulated by `StreamAccumulator` and emitted via SSE for real-time UI updates (not persisted).
   - **Complete messages**: Saved to database with incrementing sequence numbers, emitted via SSE.
5. Browser client receives SSE events (over the single multiplexed per-session stream — see [Real-Time Updates](#real-time-updates-sse)) and updates the message cache.
6. On completion, `result` message marks end of turn.

### System Prompt

A system prompt is appended to all Claude sessions to ensure proper workflow. Since users interact through the web interface and have no local access to files, Claude must always commit, push, and open PRs for changes to be visible.

The system prompt instructs Claude to:

1. Always commit changes with clear, descriptive commit messages
2. Always push commits to the remote repository
3. Open a Pull Request (using `gh pr create`) for new branches or changes that benefit from review
4. If a PR already exists, just push to update it

This ensures users can see all changes through GitHub, which is their only way to access the codebase.

### Interruption Flow

Interrupt stops the **current turn only** — the streaming query stays alive (it is reusable for the next turn, confirmed by the spike).

1. User clicks "Stop" in UI (shown only while a main-agent turn is active)
2. Server calls `claude.interrupt()`, which calls `interrupt()` on the SDK query
3. The SDK emits a terminal `result` (`subtype: 'error_during_execution'`); the loop's `reduceSessionMessage` maps any top-level `result` to `turnActive = false`. This is purely **event-driven** — no interrupt timer
4. `markLastMessageAsInterrupted` marks the last **main-agent** message (skipping interleaved background/system task messages)
5. The user can immediately send a new prompt — same query, no re-establish

There are deliberately **no status timers** (no interrupt backstop, no turn watchdog). The server cannot distinguish a genuinely hung turn from a slow one by observation, so any timer would be a guess. Recovery for a hung turn is user-driven and deterministic: the header **Stop** (`sessions.stop`) closes the query → the loop `finally` forces `turnActive` off.

Interrupt does **not** stop background tasks; those are stopped individually via `claude.stopBackgroundTask` (→ `query.stopTask`).

### Reconnection Flow

Reconnection is handled by the SSE layer's native resume rather than an explicit
catch-up query (see [Real-Time Updates](#real-time-updates-sse)):

1. `EventSource` auto-reconnects after a transient drop, sending the `Last-Event-ID`
   header tRPC delivers as the subscription's `lastEventId` input.
2. The server parses the resume token, replays persisted messages with `sequence`
   greater than the token's watermark, then resumes live streaming.
3. The client merges replayed messages into the React Query cache (deduped by id).
4. Latest-value state (running, commands, PR, session, retry, background tasks) is not
   replayed; the client refetches those queries on reconnect (`useRefetchOnReconnect`)
   as a resync.
5. A `ConnectionStatusIndicator` shows a "reconnecting" banner while the stream is
   not connected.

**Server restart recovery.** A restart loses the in-memory query but not the session's
intent: a session stays in DB status `running` and is revived lazily (with `resume`) on
the next interaction via `ensureSessionQuery`. Startup reconciliation (`reconcileSessions`)
no longer force-stops anything — it only counts running sessions for an informative log.
A background task that was mid-flight when the server died cannot be resurrected (its
subprocess is gone); recovery restores the conversation, not in-flight background work.

### Deletion Flow

1. User deletes session
2. Server stops any running Claude query
3. Server removes workspace directory
4. Session is archived (messages preserved for viewing)

## Claude Agent SDK Integration

The Next.js server uses the `@anthropic-ai/claude-agent-sdk` directly in-process to interact with Claude. No per-session processes, containers, or IPC.

### Query Model

Each session has **one long-lived `query()` running in streaming-input mode** (the `prompt` is an `AsyncIterable<SDKUserMessage>` — a pushable input channel; see `createPushable` in [`src/lib/pushable.ts`](../src/lib/pushable.ts)). The query is established lazily (`ensureSessionQuery`), stays alive across turns and idle periods, and is torn down only on stop / delete / shutdown / fatal error.

This is required for **background tasks** (the `Agent` tool with `run_in_background`, `Monitor` watches, backgrounded `Bash`): the SDK delivers their `task_started` / `task_notification` messages later in the same stream — and, when a task settles, the main agent **autonomously continues** in a new turn — but only while the stream stays open. The previous one-`query()`-per-prompt model closed the stream at each turn's `result`, killing any waiter. (Confirmed by `scripts/spike-streaming-resume.ts`.)

Key properties:

- `ensureSessionQuery(sessionId)` is idempotent and coalesced (concurrent callers share one establishment; the in-flight promise is cleared in `finally` so a failed establish can retry).
- It resumes prior history with `options.resume` when the session already has messages. **The `cwd` must be stable across a resume** — Claude Code keys sessions by project dir — so revival always uses the session's persistent `workingDir`.
- `sendUserMessage` pushes a user message into the input channel; the persistent `runSessionLoop` consumes output, folds every message through the pure `reduceSessionMessage` ([`src/lib/session-status.ts`](../src/lib/session-status.ts)), persists complete messages, and emits SSE.

### User Input (canUseTool)

The SDK's `canUseTool` callback handles interactive tools:

- **AskUserQuestion** / **ExitPlanMode**: The callback parks a `Promise` (keyed by the SDK's `toolUseID`) in the in-memory session state. It is resolved when the user responds — see [Answering Interactive Tools](#answering-interactive-tools). The request appears as a normal assistant message (`tool_use` block) in the UI.
- **All other tools**: Auto-approved (`bypassPermissions` mode).

### Answering Interactive Tools

The hard part is that the parked `Promise` lives only in the in-memory session map. It is destroyed when the query ends — **stop, delete, or a server restart** (the persistent query now survives turn completion and interrupt) — but the `tool_use` block survives in the database forever. If the UI decided interactivity from its own state, the two could disagree (controls shown for a question that can no longer be answered), or a transient running-state signal could wrongly disable the controls. To avoid this, **the server is authoritative** and the UI stays dumb:

- **UI rule**: answer controls are shown whenever a `tool_use` block has no matching `tool_result` (purely DB-derived in `MessageList`/`AskUserQuestionDisplay`/`ExitPlanModeDisplay`). The UI never consults running-state to decide interactivity. On submit it calls `claude.answerQuestion` / `claude.respondToPlan` with the block's `toolUseId`.
- **Server routing** (`submitToolResponse` in [`src/server/routers/claude.ts`](../src/server/routers/claude.ts)):
  1. **Live** — if a query is still parked on that `toolUseId`, resolve the in-memory promise so the current turn continues (cheap, no new turn). With the persistent streaming query this is the **common** path. `submitLiveToolResponse` polls while a **live query** exists (not while `turnActive`), since a parked question keeps the turn active anyway. A short wait covers the rare race where the answer beats the SDK's `canUseTool` call.
  2. **Fallback** — if no live promise exists (the query was stopped or lost to a server restart), the original tool call can never be resolved, so the answer is delivered as a **new turn**: the server persists a synthetic `tool_result` for the block (pairing it in the UI so the controls disappear) and resumes the session with a prompt built from the answer.
- **Idempotency**: the synthetic `tool_result`'s message id is derived from the `toolUseId`, so a duplicate submit hits the unique constraint and is a no-op (`routed: 'already'`) — a double answer never starts two turns.
- **Mapping responses**: an `AskUserQuestion` answer resolves `allow` with the selected answers; an `ExitPlanMode` approval resolves `allow`, while "request changes" resolves `deny` with the feedback message so Claude revises in place. On the fallback path these become natural-language prompts (see `formatToolResponsePrompt` in [`src/lib/tool-response.ts`](../src/lib/tool-response.ts)).

**Known limitation**: only a single `pendingInput` is parked at a time; if a second interactive tool call arrives before the first is answered (more likely now that long-lived background subagents exist), the earlier one is superseded (rejected). A keyed map of pending inputs + multi-question UI would be needed to answer several at once.

### Streaming

The SDK emits `stream_event` messages which are accumulated by `StreamAccumulator` into partial assistant messages for real-time UI updates. These are emitted to the browser via SSE but not persisted.

**Implementation:** [`src/server/services/claude-runner.ts`](../src/server/services/claude-runner.ts)

### Real-Time Updates (SSE)

All live server→client updates flow over **SSE** via tRPC's `httpSubscriptionLink`
(client→server actions are ordinary HTTP mutations, so a bidirectional transport like
WebSockets is unnecessary). `httpSubscriptionLink` opens one `EventSource` per
subscription, so the app is deliberately structured around just **two** streams:

1. **Per-session multiplexed stream** — `sse.onSessionEvents({ sessionId })`. A single
   subscription yields a discriminated union of every event kind for the session
   (`message`, `running`, `commands`, `pr`, `session`, `retry`, `background`). The server
   folds the seven in-process emitter channels into this union via `sseEvents.onSessionEvents`
   ([`events.ts`](../src/server/services/events.ts)). On the client, `useSessionStream`
   ([`src/hooks/useSessionStream.ts`](../src/hooks/useSessionStream.ts)) is mounted once
   per session page and fans each event to the relevant React Query cache (the message
   merge uses the pure `mergeMessageIntoCache` in
   [`src/lib/message-cache.ts`](../src/lib/message-cache.ts)). The query hooks
   (`useSessionMessages`, `useSessionState`, `useClaudeState`, `usePullRequestStatus`)
   are read/mutate-only and never open their own subscriptions.

2. **Global session-list stream** — `sse.onSessionListEvents()`. `emitSessionUpdate`
   fans every session change out to a global channel; `useSessionListStream`
   ([`src/hooks/useSessionListStream.ts`](../src/hooks/useSessionListStream.ts)) refetches
   the home-page list so it updates live for any session, without one subscription per row.

**Resume tokens & catch-up.** The subscription input is **stable** — `{ sessionId,
afterSequence }`, where `afterSequence` is the client's newest cached sequence captured
**once** when history first loads and then frozen (`useSessionStream` gates the subscription
until then). Feeding the live newest sequence reactively would tear the `EventSource` down
every turn. Each yielded event is wrapped in tRPC's `tracked(id, ...)` where the id is a
`` `${watermark}:${counter}` `` token ([`src/lib/sse-resume.ts`](../src/lib/sse-resume.ts)):

- `watermark` = the highest persisted message `sequence` yielded so far. The server replays
  `message.sequence > floor`, where the floor is the `lastEventId` watermark on reconnect,
  or the initial `afterSequence` on first connect (which closes the window between the
  `getHistory` snapshot and the stream attaching), or none (anchor at current max) otherwise.
  Only complete (persisted) messages advance the watermark — partials and latest-value
  events do not, so they are streamed live but never replayed (the client refetches their
  state on reconnect instead).
- `counter` = strictly increasing per connection, seeded from the previous `lastEventId`, so
  ids never repeat across reconnects (tRPC drops events with a repeated tracked id).

**Failure handling.** `EventSource` auto-reconnects with `Last-Event-ID`; on a connection
error the client also refetches the affected queries (`useSessionStream` / `useRefetchOnReconnect`)
and surfaces a `ConnectionStatusIndicator` banner. tRPC SSE ping/reconnect is configured in
[`src/server/trpc.ts`](../src/server/trpc.ts) (`ping.intervalMs`, `client.reconnectAfterInactivityMs`).

### Thinking Blocks

When extended thinking is active, assistant messages include `thinking` (and, when the API encrypts reasoning, `redacted_thinking`) content blocks alongside `text` and `tool_use`. These are accumulated during streaming (`thinking_delta` events) and rendered as a single collapsed "Thinking" section per message (`ThinkingDisplay`), coalescing multiple thinking blocks into one. Thinking text is excluded from copy/voice output.

During redacted thinking the SDK also emits frequent `{ type: 'system', subtype: 'thinking_tokens' }` progress messages carrying only live token-count estimates. These are dropped (not persisted or shown) via `isIgnoredSystemMessage` in [`src/lib/claude-messages.ts`](../src/lib/claude-messages.ts) — one of several ignored system subtypes (see [System Message Subtypes](#system-message-subtypes)) — so they don't render as a stream of empty "System" bubbles.

### Message Classification

Every message yielded by the SDK is routed through `classifyMessage(message)` in [`src/lib/claude-messages.ts`](../src/lib/claude-messages.ts), which returns one of `{ kind: 'stream_event' | 'skip' | 'persist' }` (with the DB column type for `persist`). It `switch`es over the SDK's `SDKMessage` discriminated union and ends in `assertNeverFallback`, a compile-time exhaustiveness guard: if a future SDK release adds a top-level message `type`, the build fails until it is handled here. At runtime an unrecognized type degrades to generic system persistence rather than throwing, so an unexpected frame never crashes the query loop.

### System Message Subtypes

The SDK emits many `type: 'system'` subtypes. A single `type`-level switch can't distinguish them, so subtype handling is split into three buckets (none of which is compile-time exhaustive — unknown subtypes fall through to a safe default):

1. **Ignored** (`IGNORED_SYSTEM_SUBTYPES` + any message flagged `skip_transcript`): pure progress ticks and internal state — `thinking_tokens`, `task_progress`, `task_updated`, `hook_progress`, `status`, `session_state_changed`, `files_persisted`, `elicitation_complete`, `commands_changed`, `api_retry`. `classifyMessage` returns `skip`, so they are never persisted; `isIgnoredSystemMessage` also filters any persisted before a subtype was added (both at the list level in `MessageList` so they leave no empty spacer row, and as a guard in `MessageBubble`).
2. **Dedicated displays**: `init`, `compact_boundary`, `hook_started`, `hook_response`, and the app's synthetic `error` each have their own component.
3. **Generic summary**: everything else (e.g. `notification`, `permission_denied`, `model_refusal_fallback`, `plugin_install`, `memory_recall`, `mirror_error`, `task_started`, `task_notification`) renders through `SystemMessageDisplay`, which calls `summarizeSystemMessage` to produce a never-blank `{ label, body, level }`. Unknown/future subtypes degrade to a humanized label plus any string `content`, so a system message is never an empty bubble. `level: 'warn'` (retries, denials, errors) gets an amber treatment.

Subagent (`Task` tool) lifecycle: `task_started` and `task_notification` are the meaningful bookends and are summarized; the high-frequency `task_progress` ticks and `task_updated` patches are not persisted/shown. **However**, the live-status reducer still inspects `task_updated` off the raw stream (it runs on every message, before classification): a terminal `patch.status` (`completed`/`failed`/`killed`) settles a background task too. This backstops the fact that `task_notification` is only _explicitly_ promised by the SDK after `stopTask` and when a backgrounded foreground task settles — for other endings (notably `killed`, which has no `task_notification` status) or a dropped notification, the terminal `task_updated` keeps a finished task from lingering. `task_started` / `task_notification` / terminal `task_updated` drive the live **background-task** status (see [Two-Axis Status & Background Tasks](#two-axis-status--background-tasks)).

### Two-Axis Status & Background Tasks

With one persistent query per session, "is Claude busy?" splits into two **independent** facts, both derived purely from the message stream by `reduceSessionMessage` ([`src/lib/session-status.ts`](../src/lib/session-status.ts)) and held in memory:

- **`turnActive`** — whether the **main agent** is actively generating. Driven by the message **stream**, not the SDK turn `result`: a top-level (`parent_tool_use_id == null`) `stream_event` of `message_start` sets it true; a top-level `message_delta` whose `stop_reason` is terminal (`end_turn`/`stop_sequence`/`max_tokens`/`refusal`; `tool_use`/`pause_turn` mean the turn continues) sets it false. A top-level `result` also clears it as a safety net (and covers an interrupt's `error_during_execution`). **Why the stream and not the `result`:** a `run_in_background` subagent keeps the parent turn open — the SDK defers the turn `result` until the child settles — but the main agent finishes generating much earlier, so keying off `result` alone would wrongly show "running" for the entire background-subagent duration (confirmed by `scripts/spike-background-agent.ts`). Subagent traffic never moves it. This is the **only** input gate: emitted over the `running` SSE channel and read via `claude.isRunning`; the composer and Stop button key off it.
- **background tasks** — a `Map<task_id, BackgroundTask>` driven by `task_started` (add) / `task_notification` **or** a terminal `task_updated.patch.status` (remove — two signals because the SDK only explicitly promises `task_notification` for `stopTask` and foreground-backgrounding; the authoritative `task_updated` state channel backstops every other ending and dropped notifications). Emitted as a latest-value `background` SSE event and read via `claude.getBackgroundTasks` (seeded once, updated by the stream, resynced on reconnect). This is an **indicator only** — it never gates input, so a user can keep chatting while a background task runs. This is genuinely interactive, not just cosmetic: a prompt sent while a background subagent runs is answered in a new turn that **interleaves** with the still-running subagent (confirmed by `scripts/spike-concurrent-send.ts` — the reply arrived ~19s before the subagent's `sleep 20` settled), not queued until it finishes. `ClaudeStatusIndicator` shows a separate "N background tasks running — you can keep chatting" line with per-task stop controls (`claude.stopBackgroundTask` → `query.stopTask`, then **optimistic removal**: the runner drops the entry from the live set itself rather than waiting for the SDK's terminal `task_notification`, so the ✕ reliably clears the indicator whether the task is still alive or a phantom whose notification was dropped — if it was real and the notification arrives later, the reducer's removal is a `has`-guarded no-op). The pure map-removal (`removeBackgroundTask` in [`session-status.ts`](../src/lib/session-status.ts)) is shared by the settle paths and the stop path. _Known limitation_: a task lingers in the map only if **all three** of `task_notification`, a terminal `task_updated`, and a user ✕ never happen — at which point it clears when the query is torn down. Since it is indicator-only, the impact is a stale count, never a stuck composer.

`turnActive` is **purely event-driven** — set/cleared only by messages and forced false on every loop-exit path (SDK error, query close, stop/delete/shutdown). There are no status timers: the server can't tell a hung turn from a slow one, so a genuinely hung turn is recovered deterministically by the user (interrupt, or the header Stop which closes the query → `finally` clears the flag). A consequence: a persistent subprocess lives until stop / delete / shutdown / fatal error (no idle reaper) — fine for a single-user host with a handful of sessions. Both facts are in-memory only (lost on restart, re-derived as the revived query streams).

**Ephemeral retry status.** `api_retry` messages (the SDK retrying a rate-limited/overloaded request) are ignored above so they never pollute the transcript, but the _current_ retry state is surfaced live. The runner parses each via `parseRetryState` ([`claude-messages.ts`](../src/lib/claude-messages.ts)), stores it on the in-memory session state, and emits it over the `retry` SSE channel as a latest-value event (`{ attempt, maxRetries, errorStatus?, error? } | null`). Any non-retry message clears it (the request recovered), as does turn end. The client reads it via `claude.getRetryState` (seeded once, updated by the stream, resynced on reconnect) and `ClaudeStatusIndicator` shows "Retrying (overloaded) — attempt n/10…" while it is set. Because it is in-memory only, a server restart loses it — acceptable for a transient indicator.

## Message Storage & Pagination

Messages are stored with a monotonically increasing sequence number per session (see `Message` model in [`prisma/schema.prisma`](../prisma/schema.prisma)). This enables efficient cursor-based pagination.

### Pagination Queries

**Load recent (initial view):**

```sql
SELECT * FROM messages
WHERE session_id = ?
ORDER BY sequence DESC
LIMIT 50;
```

**Load older (scroll up):**

```sql
SELECT * FROM messages
WHERE session_id = ? AND sequence < ?
ORDER BY sequence DESC
LIMIT 50;
```

**Poll for new (after reconnect):**

```sql
SELECT * FROM messages
WHERE session_id = ? AND sequence > ?
ORDER BY sequence ASC;
```

## Security

### Authentication Layers

1. **Tailscale Serve/Funnel** — Traffic encrypted over HTTPS, no exposed ports
2. **Password Authentication** — Single-user auth with:
   - Password stored as base64-encoded Argon2 hash in `PASSWORD_HASH` env var
   - Database-backed sessions with 256-bit random tokens
   - 7-day session expiration
   - Session tracking (IP address, user agent) for audit

### Session Isolation

- Each session runs in its own git clone at `/worktrees/{sessionId}/`
- Agents share the host filesystem, user, and installed tools
- `bypassPermissions` mode is used since the machine is dedicated to running this app
- The machine should be dedicated to this application — not shared with other users

### GitHub Token Security

- Use a **fine-grained Personal Access Token** for minimum required permissions
- Scope the token to only the repositories you want to use
- Grant only "Contents: Read and write" permission (for push/pull)
- Create at: https://github.com/settings/personal-access-tokens/new
- The token is configured via a git credential helper in each clone

### Per-Repository Settings & Secrets

Users can configure per-repository settings that are automatically applied when creating sessions. This also applies to "No Repository" sessions, which use the sentinel value `__no_repo__` as their `repoFullName` in `RepoSettings`.

- **Favorites**: Mark repositories (or "No Repository") as favorites so they appear at the top of the repo selector
- **Custom System Prompt**: Additional instructions appended to the default system prompt for all sessions using this repository
- **Claude Model**: Override the model for all sessions using this repository. Takes precedence over the global model and the `CLAUDE_MODEL` env var. Falls back to those when not set.
- **Environment Variables**: Custom env vars set for Claude sessions (e.g., API keys, config values)
- **MCP Servers**: Configure [MCP servers](https://modelcontextprotocol.io/) for Claude to use, supporting three transport types:
  - **Stdio**: Traditional command-based servers (e.g., `npx @anthropic/mcp-server-memory`)
  - **HTTP**: Streamable HTTP MCP servers with optional auth headers
  - **SSE**: Server-Sent Events MCP servers with optional auth headers

**Secret Encryption**: Environment variables, MCP server env vars, and HTTP/SSE header values can be marked as "secret", which:

- Encrypts the value at rest using AES-256-GCM with the `ENCRYPTION_KEY` env var
- Displays masked values (`••••••••`) in the UI
- Decrypts values only when starting a Claude query (passed as environment or SDK options)

**Configuration**:

1. Set `ENCRYPTION_KEY` to a 32+ character random string (generate with: `openssl rand -base64 32`)
2. Go to Settings → Repositories to manage per-repo settings
3. Or use the star icon in the new session repo selector to toggle favorites

**Implementation**: See [`src/server/routers/repoSettings.ts`](../src/server/routers/repoSettings.ts) for the API and [`src/lib/crypto.ts`](../src/lib/crypto.ts) for encryption.

### Global Settings

Users can configure global settings that apply to all sessions:

- **Claude Model**: Override the `CLAUDE_MODEL` environment variable. Free-text field accepting model names like `opus`, `sonnet`, or full IDs like `claude-opus-4-6`. A per-repo model override (if set) takes precedence over this; otherwise this is used, falling back to the env var default when neither is set. Resolution order is `repo model → global model → CLAUDE_MODEL env var` (see `resolveClaudeModel` in `settings-merger.ts`).
- **Advisor Model**: The model used by the server-side advisor tool (which Claude can consult for a second opinion mid-session). Uses the same free-text model selector as Claude Model. This is a global-only setting with **no env-var or per-repo layer**: the effective value is `global advisor model → DEFAULT_ADVISOR_MODEL` (`claude-fable-5`), resolved by `resolveAdvisorModel` in `settings-merger.ts`. Because the value always resolves, the advisor tool is **always enabled** — clearing the override reverts to the Fable 5 default rather than turning it off. The advisor model is a settings-schema field with no dedicated SDK option, so it is passed to the Claude Agent SDK as an ad-hoc `--settings` source via `Options.extraArgs` (`{ advisorModel }`); see `buildSdkOptions` in `claude-runner.ts`. This only takes effect on a CLI/SDK version that actually implements the advisor tool: it wires the `advisor_20260301` server tool into each request (the `advisor-tool-2026-03-01` beta header is already sent unconditionally by the CLI). The dependency is pinned to an exact version (`@anthropic-ai/claude-agent-sdk` `0.3.196`) because earlier versions (e.g. `0.3.173`) ignore `advisorModel` entirely and `0.3.198` ships a dangling `SDKConversationResetMessage` type that degrades `SDKMessage` to `any` and breaks the `classifyMessage` exhaustiveness guard. To re-verify after a bump, capture the CLI's outgoing `/v1/messages` request (e.g. a logging proxy set via `ANTHROPIC_BASE_URL`) and check the `tools` array for `advisor_20260301`.
- **Claude API Key**: Override the `CLAUDE_CODE_OAUTH_TOKEN` environment variable. Stored encrypted at rest. The actual value is never exposed to the UI — only a "configured" status is shown. Falls back to the env var when not set.
- **System Prompt Override**: Replace the default system prompt with a custom one. When editing, the field is pre-populated with the current default prompt. The override can be toggled on/off without losing the custom content.
- **Global System Prompt Append**: Additional content appended to the base prompt (default or override) for all sessions. This is applied before any per-repo custom prompts.
- **Global Environment Variables**: Environment variables applied to all sessions. Per-repo variables with the same name take precedence.
- **Global MCP Servers**: MCP server configurations available in all sessions. Per-repo servers with the same name take precedence. Supports stdio, HTTP, and SSE transport types.
- **TTS Speed**: Controls text-to-speech playback speed (0.25x to 4.0x, default 1.0x). Passed to `SpeechSynthesis.rate` via the browser's Web Speech API. Configured in Settings → Audio.
- **Voice Auto-Send**: When enabled (default: true), speech-to-text transcripts are automatically sent as prompts after recording stops. When disabled, transcripts are inserted into the input field for editing. Configured in Settings → Audio.

**Prompt Order**: When Claude runs, the system prompt is built in this order:

1. Base prompt (either the default or the override if enabled)
2. Global append content (if set)
3. Per-repository custom prompt (if set for that repo)

**Settings Merging**: When a session starts, global and per-repo settings are merged:

- **Environment Variables**: Global env vars are included in all sessions. If a per-repo env var has the same name as a global one, the per-repo value takes precedence.
- **MCP Servers**: Global MCP servers are included in all sessions. If a per-repo MCP server has the same name as a global one, the per-repo configuration takes precedence.
- **Claude Model**: Resolved in precedence order `per-repo model → global model → CLAUDE_MODEL env var`.

**Live vs. restart-bound settings.** Because a session's query is long-lived, settings are bound when the query is established. **Model and MCP servers** are re-applied live on the next `send` when they differ from what the query was built with (`query.setModel` / `query.setMcpServers`, gated by `mcpServersEqual`). **Environment variables, the system prompt, and the advisor model** are bound at construction and only take effect after a Stop→Start (which rebuilds the query with fresh settings) — the SDK exposes no live setter for the advisor model.

**Configuration**: Go to Settings → System Prompt to manage prompt and model settings. Go to Settings → Audio to manage voice/audio settings (TTS speed, voice auto-send).

**Data Model**: Global env vars and MCP servers are stored in the same `EnvVar` and `McpServer` tables as per-repo ones, with `repoSettingsId = null` indicating a global setting. A partial unique index (`WHERE repoSettingsId IS NULL`) enforces name uniqueness for global entries at the database level.

**Implementation**: See [`src/server/routers/globalSettings.ts`](../src/server/routers/globalSettings.ts) for the API, [`src/server/services/global-settings.ts`](../src/server/services/global-settings.ts) for the service layer, [`src/server/services/settings-merger.ts`](../src/server/services/settings-merger.ts) for the merging logic, and [`src/server/services/settings-helpers.ts`](../src/server/services/settings-helpers.ts) for shared validation schemas, encryption helpers, and decrypt functions used by both global and per-repo settings.

### Voice Mode

Voice mode provides speech-to-text input and text-to-speech output for hands-free interaction with Claude sessions using browser-native Web Speech APIs. No API keys or server-side processing required.

**Requirements**: A browser that supports the Web Speech API. `SpeechRecognition` provides STT (Chrome, Edge, Safari; not Firefox without a flag). `SpeechSynthesis` provides TTS (all major browsers).

**Architecture**:

- **Voice input (STT)**: Browser `SpeechRecognition` API provides real-time transcription directly in the browser. No server round-trip needed. Supports interim results for real-time feedback during recording.
- **Voice output (TTS)**: Browser `SpeechSynthesis` API speaks text locally. Long text is chunked at sentence boundaries to work around Chrome's ~15-second utterance bug ([Chromium bug](https://issues.chromium.org/issues/41294170)). `SpeechSynthesisUtterance.rate` is set from the TTS Speed setting.

**Known Limitations**:

- TTS quality is lower than cloud-based solutions (varies by OS/browser)
- Chrome: utterances over ~15s stop abruptly (worked around by chunking)
- Android: `speechSynthesis.pause()` acts as `cancel()` — pause/resume doesn't work
- Background tabs: `SpeechSynthesis` may be silenced/cancelled when tab is backgrounded
- STT: `SpeechRecognition` not available in Firefox (without a flag)
- iOS: requires user activation for `speak()` calls

**Components**:

- `VoiceControlPanel`: Inline voice controls panel that replaces PromptInput when voice mode is active. Provides playback navigation (prev/next/play/pause/stop), a large mic button for recording, send/cancel for transcripts, and an exit button. Renders as a normal flow element at the bottom of the session view (not a modal).
- `VoiceMicButton`: Push-to-talk button in PromptInput. Click to start recording, click again to stop. Shows interim transcript during recording.
- `MessagePlayButton`: Per-message play/pause button on assistant messages. Visible when voice is enabled.
- `VoiceAutoReadToggle`: Toggle in SessionHeader. When enabled, automatically speaks the last assistant message when Claude finishes a turn.

**Hooks**:

- `useVoiceConfig`: Detects browser Web Speech API support and manages auto-read preference per session (localStorage). Queries server for `ttsSpeed` and `voiceAutoSend` settings.
- `useVoiceRecording`: Wraps the browser `SpeechRecognition` API. Provides real-time interim transcripts and final results.
- `useVoicePlayback`: Central playback state via React Context. Uses `SpeechSynthesis` for TTS with text chunking for Chrome compatibility. Supports sequential playback queue for auto-read.

**Implementation**: See [`src/hooks/useVoiceRecording.ts`](../src/hooks/useVoiceRecording.ts), [`src/hooks/useVoicePlayback.ts`](../src/hooks/useVoicePlayback.ts), [`src/hooks/useVoiceConfig.ts`](../src/hooks/useVoiceConfig.ts), and [`src/components/voice/`](../src/components/voice/) for UI components.

## UI Screens

### Session List (Home)

- List of sessions with name, repo, status, last activity
- "New Session" button
- Quick actions: resume, stop, delete

### New Session

- Search/select GitHub repo **or** "No Repository (workspace only)" for repo-free sessions
  - "No Repository" is shown in the repo selector, favoritable, and configurable via RepoSettings (uses `__no_repo__` sentinel)
  - When "No Repository" is selected, branch and issue selectors are hidden
- Select branch (defaults to default branch) — only shown for repo sessions
- Optional: Select a GitHub issue to work on — only shown for repo sessions
  - Searchable dropdown with open issues
  - When selected, auto-fills session name with issue title
  - Pre-fills initial prompt asking Claude to fix the issue (editable)
- Name the session (optional, auto-filled from issue if selected, defaults to "Workspace" for no-repo)
- Initial prompt (optional) — editable textarea, pre-filled when issue is selected
  - If provided, sent server-side after session setup completes (works even if client disconnects)
  - When omitted, session starts without a prompt (useful for voice mode)
- Create button

### Session View (Chat)

- Message history with lazy loading on scroll up
- Input field for new prompts
- Stop button (visible during Claude execution)
- Tool calls rendered with expandable input/output
- Status indicator (running, waiting, stopped)
- Session info in header (repo, branch)

## File Structure

```
clawed-abode/
├── shared/
│   └── agent-types.ts          # Shared types (PartialAssistantMessage)
├── scripts/
│   ├── hash-password.ts        # Password hashing utility
│   └── update.sh               # Production update: pull, install, migrate, build, restart
├── src/
│   ├── server/
│   │   ├── routers/
│   │   │   ├── index.ts           # Router exports
│   │   │   ├── auth.ts
│   │   │   ├── github.ts
│   │   │   ├── sessions.ts
│   │   │   ├── claude.ts
│   │   │   ├── sse.ts             # SSE event streaming
│   │   │   ├── repoSettings.ts
│   │   │   └── globalSettings.ts
│   │   ├── services/
│   │   │   ├── worktree-manager.ts # Git clone lifecycle
│   │   │   ├── claude-runner.ts   # Persistent per-session streaming query + loop
│   │   │   ├── stream-accumulator.ts # Accumulates stream_events into partials
│   │   │   ├── global-settings.ts # Global settings service
│   │   │   ├── repo-settings.ts   # Per-repo settings service
│   │   │   ├── settings-helpers.ts # Shared schemas, encryption, decrypt helpers
│   │   │   ├── settings-merger.ts # Merges global + per-repo env vars and MCP servers
│   │   │   ├── events.ts         # SSE event emitter
│   │   │   ├── anthropic-models.ts # Claude model configuration
│   │   │   ├── github.ts         # GitHub API service
│   │   │   ├── mcp-validator.ts  # MCP server config validation
│   │   │   └── session-reconciler.ts # Counts running sessions for lazy revive on restart
│   │   └── trpc.ts
│   ├── lib/
│   │   ├── auth.ts               # Authentication utilities
│   │   ├── crypto.ts             # Encryption/decryption (AES-256-GCM)
│   │   ├── logger.ts             # Centralized logging (createLogger)
│   │   ├── prisma.ts             # Prisma client initialization
│   │   ├── trpc.ts               # tRPC client setup
│   │   ├── pushable.ts           # Pushable async iterable (streaming-query input channel)
│   │   ├── session-status.ts     # Pure reducer: turnActive + background tasks + retry
│   │   ├── system-prompt.ts      # Pure system-prompt builder (DEFAULT_SYSTEM_PROMPT)
│   │   ├── message-cache.ts      # Pure merge of live messages into the infinite-query cache
│   │   ├── sse-resume.ts         # Resume-token (watermark:counter) format/parse for SSE
│   │   └── types.ts              # Global TypeScript types
│   ├── hooks/                    # React hooks (useSessionStream + useSessionListStream for SSE,
│   │                             #   useSessionMessages/State, useClaudeState, etc.)
│   ├── app/
│   │   ├── page.tsx              # Session list
│   │   ├── new/page.tsx          # New session
│   │   ├── session/[id]/page.tsx # Session view
│   │   ├── settings/page.tsx     # Settings
│   │   └── login/page.tsx
│   └── components/
│       ├── MessageList.tsx
│       ├── PromptInput.tsx
│       ├── SessionList.tsx
│       ├── ConnectionStatusIndicator.tsx # "Reconnecting" banner when the SSE stream is down
│       ├── Header.tsx
│       ├── messages/             # Tool-specific display components (Bash, Edit, Read, etc.)
│       ├── settings/             # Settings UI (global settings, repo settings, audio, env vars, MCP)
│       ├── ui/                   # shadcn/ui primitives (button, dialog, input, etc.)
│       └── voice/               # Voice UI components
│           ├── VoiceControlPanel.tsx
│           ├── VoiceMicButton.tsx
│           ├── MessagePlayButton.tsx
│           └── VoiceAutoReadToggle.tsx
├── prisma/
│   └── schema.prisma
└── package.json
```

## Testing

### Test Categories

- **Unit tests** (`*.test.ts`): Pure functions and isolated logic. Run with `pnpm test:unit`.
- **Integration tests** (`*.integration.test.ts`): Tests using real external systems (git, SQLite). Run with `pnpm test:integration`.

### Test File Locations

Tests are co-located with source files:

- `src/lib/auth.ts` → `src/lib/auth.test.ts`
- `src/server/services/git.ts` → `src/server/services/git.integration.test.ts`

### Running Tests

```bash
pnpm test          # Watch mode
pnpm test:run      # Single run
pnpm test:unit     # Unit tests only
pnpm test:integration  # Integration tests only
pnpm test:coverage # With coverage report
```
