# Plan: Persistent streaming-input session queries

> **Superseded / historical.** This is the original implementation plan. The
> shipped design is the source of truth in [`doc/DESIGN.md`](../DESIGN.md) and
> differs in places — most notably there are **no status timers** (the turn
> watchdog and idle reaper described below were implemented and then removed in
> favor of purely event-driven `turnActive` with user-driven recovery), and
> `runClaudeCommand` / `markAllSessionsStopped` no longer exist. Read this for
> rationale and history, not current behavior.

## Problem

Today each user prompt is a **single-message** `query()` call. The turn's `result`
closes the SDK stream, the `for await` loop in `runClaudeCommand`
(`src/server/services/claude-runner.ts`) exits, and the `finally` tears down all
in-memory session state. Consequently any background task the agent spawns
(`Agent` tool with `run_in_background: true`, `Monitor` watches, backgrounded
`Bash`) is killed at end of turn — "waiters always end at the end of the turn."
The SDK delivers `task_started` / `task_notification` messages _later in the same
stream_, which is only possible if the stream stays open.

## Goal / core invariant

> A session in DB status `running` has exactly one long-lived `query()` running in
> **streaming-input mode**. It is established lazily, stays alive across turns and
> idle periods (so background tasks survive and their `task_notification` flows
> back to the main agent), and is torn down only on stop / delete / shutdown /
> fatal error.

Plus:

- The frontend composer must be gated by **main-agent turn activity only**, never
  by background-task activity.
- Clean recovery if the server dies: running sessions are revived (resumed) on the
  next interaction.

## SDK semantics — VERIFIED by spike

All three load-bearing assumptions were confirmed by
`scripts/spike-streaming-resume.ts` against `@anthropic-ai/claude-agent-sdk@0.3.173`
with real auth (run by the user 2026-06-22; all PASS). The spike is kept in-repo as
a regression check for SDK upgrades.

1. **CONFIRMED — streaming input + `resume`.** A streaming-input query with
   `options.resume = sessionId` recalls prior history (the spike's phase-2 query
   recited a secret stored in phase 1). **Critical caveat the spike exposed:** the
   `cwd` MUST be identical across the resume — Claude Code stores sessions per-project
   keyed by `cwd`, and resuming under a different `cwd` fails to load the session
   (yields only a bare `result:error_during_execution`, no `init`). The app already
   reuses each session's `workingDir`, so this holds in production — but
   `ensureSessionQuery` must always pass the stable session `workingDir` on revive.
2. **CONFIRMED — `interrupt()`.** Interrupt mid-turn emitted
   `result:error_during_execution` and the SAME query accepted a follow-up turn
   afterward (replied "ALIVE"). Streaming-only. We key `turnActive=false` on any
   top-level `result`; the timeout backstop remains as defense in case a future
   version skips the result.
3. **CONFIRMED — background task + auto-continue.** A `run_in_background` Bash task
   emitted `task_started`, then (while the query sat idle, no new user input)
   `task_notification`, and the main agent **autonomously started a new turn**
   (`"AUTO_CONTINUED BG_TASK_FINISHED"`). This is the whole feature premise and it
   works as designed.

### Spike findings to bake into the implementation

- **A single streaming query emits multiple `system:init` messages** — one per turn,
  including the autonomous post-`task_notification` turn. `classifyMessage` /
  command-merge already tolerate this, but the loop must NOT treat a second `init` as
  a new session or re-anchor sequence; just re-merge commands (idempotent).
- **`rate_limit_event` (`SDKRateLimitEvent`) arrives early in most turns.** Add it to
  the reducer's ignored set (alongside the existing ignored subtypes) so it never
  persists or perturbs `turnActive`.
- **`task_updated` precedes `task_notification`** and carries interim state — keep
  ignoring it (already in `IGNORED_SYSTEM_SUBTYPES`); only `task_started` /
  `task_notification` drive the `backgroundActive` map.
- Observed turn shape for a backgrounded task:
  `init, rate_limit_event, assistant…, task_started, user(tool_result), assistant,
result:success, task_updated, task_notification, init, assistant…` — note the
  main turn's `result:success` lands BEFORE the task settles, confirming the query
  must stay alive past `result`.

4. **VERIFIED — live controls.** The `Query` object exposes `setModel(model?)`,
   `setPermissionMode()`, `setMcpServers()`, `applyFlagSettings()`, `stopTask(id)`,
   and `backgroundTasks(toolUseId?)` — all streaming-only. `env` / `systemPrompt`
   are still bound at construction (no live setter), but MCP and model CAN be applied
   live, narrowing the settings regression (see "Settings binding").
5. **VERIFIED — `SDKUserMessage` shape (0.3.173).**
   `{ type:'user'; message: MessageParam; parent_tool_use_id: string|null; session_id?: string }`.
   `parent_tool_use_id` is required (include `null`); `session_id` is optional (omit).
   Note: older docs/v2-preview show `session_id: ''` as required — this shape is
   version-fragile, so pin-awareness matters on SDK upgrades.

## Two-axis status model

Replace the single `isRunning` boolean with two independent in-memory facts:

| Fact               | Meaning                        | Gates composer?                     | Derived from                         |
| ------------------ | ------------------------------ | ----------------------------------- | ------------------------------------ |
| `turnActive`       | main agent mid-turn generating | **yes** (Send disabled, Stop shown) | top-level message flow               |
| `backgroundActive` | ≥1 background task running     | **no** (indicator only)             | `task_started` / `task_notification` |

### `turnActive` derivation (and why interrupt works)

`turnActive` is derived purely from message flow:

- top-level (`parent_tool_use_id == null`) `assistant` or `stream_event` → `true`
- top-level `result` (ANY subtype: `success`, `error_during_execution`,
  `error_max_turns`, …) → `false`
- set `true` optimistically in `send()` for instant UI feedback.

**Interrupt detection (primary path):** `query.interrupt()` normally produces a
terminal `result` (any subtype) in the same stream. The loop consumes it, the
reducer maps it to `turnActive = false`, and `running(false)` is emitted. No new
user message is required — the interrupt's own `result` is the trigger. We do **not**
optimistically set `turnActive=false` on interrupt, because draining may still yield
a late top-level message before the `result`; letting the ordered `result` be
authoritative avoids a flip-flop.

**Interrupt backstop (B2):** the SDK does NOT guarantee interrupt emits a result.
After `interrupt()` resolves, arm a short timer (e.g. 3 s); if no terminal `result`
for the active turn arrived, force `turnActive=false` + emit. A subsequent stray
result is harmless (idempotent set to false). The spike must check whether interrupt
reliably emits a result; the backstop ships regardless.

**No-stuck-true rules:** with the query no longer ending per turn, `turnActive` can
get stuck `true` in two distinct ways — handle both:

- **Loop-exit paths** force `turnActive=false`: (1) loop `catch` (SDK error mid-turn,
  possibly no `result`), (2) loop `finally` (query closed / input channel ended),
  (3) `sessions.stop` / `sessions.delete` / graceful shutdown.
- **No-op / hung turn (B1):** a pushed user message that never yields a terminal
  `result` (silent `resume` failure, SDK errors before generating, init-then-idle) is
  NOT a loop-exit, so the paths above never fire and `turnActive` stays wrongly true.
  Mitigation: a per-turn watchdog. When `send()` sets `turnActive=true`, record the
  turn start; if no top-level `result` arrives within a generous timeout, force
  `turnActive=false`, emit, and write a system error message. The clean long-term
  fix is to rely on the SDK's guarantee that each user message yields exactly one
  terminal `result` — the spike must confirm this; the watchdog is the safety net if
  it doesn't hold.

`interrupt` is a no-op (returns `success:false`) when `turnActive` is false. Stop
acts only on a live main-agent turn. **Stopping a runaway background task is a
separate control** (`query.stopTask(taskId)`) — see "Background task controls".

### `backgroundActive` derivation

A `Map<taskId, { type, description, startedAt }>`:

- `task_started` → add
- `task_notification` (any terminal status) → remove

`task_started` / `task_notification` keep being persisted & rendered in the
transcript (existing "System Message Subtypes" behavior); we _additionally_ derive
ephemeral live state from them — the same dual treatment `api_retry` already gets
(ignored-for-transcript, parsed-for-live-state).

## Server architecture (`claude-runner.ts`)

### Revised `SessionState`

```ts
interface SessionState {
  query: Query | null; // live streaming query
  input: Pushable<SDKUserMessage> | null; // input channel feeding `query`
  establishing: Promise<SessionState> | null; // coalesce concurrent ensure()
  turnActive: boolean;
  backgroundTasks: Map<string, BackgroundTask>;
  pendingInput: PendingUserInput | null; // AskUserQuestion/ExitPlanMode — unchanged
  retry: RetryState | null;
  commands: SlashCommand[];
  workingDir: string;
  boundSettings: MergedSessionSettings; // settings the live query was built with
}
```

### `createPushable<T>()` (new, pure, reusable)

Queue-backed async iterable that **awaits when empty instead of returning** (keeps
the query alive while idle). Same shape as `createEventQueue` in
`src/server/routers/sse.ts`, generalized. `close()` makes the iterator return →
query ends gracefully. Unit-testable in isolation.

### `ensureSessionQuery(sessionId)` — idempotent, lazy, coalesced

1. If `state.query` exists → return it.
2. If `state.establishing` exists → await it (coalesce — same trick as
   `pendingBaseEnv`; satisfies CLAUDE.md "no check-then-set").
3. Else: set `state.establishing` to a promise that loads merged settings, builds
   the pushable, calls `query({ prompt: pushable.iterable, options })` with
   `resume: sessionId` iff messages exist (else `sessionId`), stores on state,
   fetches `supportedCommands()` once, and starts `runSessionLoop` detached.
   **Clear `state.establishing` in a `finally`** (as `pendingBaseEnv` does at
   `claude-runner.ts`) so that if establishment throws (e.g. `resume` fails), the
   next `send` can retry instead of all coalesced awaiters being stuck on a rejected
   promise (B6).

Called from: `claude.send`, the `answerQuestion`/`respondToPlan` fallback path,
`sessions.start`, and the `initialPrompt` path in `sessions.ts`.

### `runSessionLoop(sessionId)` — long-lived loop

Body is today's `for await` minus teardown-on-`result`, plus:

- Feed each message through a pure reducer `reduceSessionMessage(state, msg)` →
  `{ turnActive, backgroundTasks, retry, emits[], persist? }`. The reducer is pure;
  a separate executor performs the I/O (sequence assignment, DB writes, SSE emits)
  so the reducer stays unit-testable (S3).
- **Sequence assignment must add collision-retry (B5).** The current loop persist
  path only swallows P2002 as a _duplicate_ and `continue`s — under persistence the
  main turn, background-task messages, and a concurrent `sendUserMessage` user-insert
  all do read-max-then-insert and can collide on `(sessionId, sequence)` with
  _distinct_ ids. Swallowing that as "duplicate" would **silently drop a real
  message**. Apply the same retry logic `persistSyntheticToolResult` already uses:
  on P2002, re-check the id — if it exists it's a true duplicate (skip), otherwise
  recompute sequence and retry.
- **Retry-clear must be turn-scoped, not "any message" (G5).** Today retry is cleared
  on any non-retry message and in the per-turn `finally`. Under persistence a
  background task's messages are "non-retry messages" that would prematurely clear a
  main-turn retry indicator, and the `finally` no longer runs per turn. Move
  retry-clear into the reducer keyed on the main turn (top-level messages / turn
  boundary), ignoring background (`parent_tool_use_id != null`) traffic.
- Exit only on: input channel closed, `query.close()`, or SDK throw.
- On throw: log, write an error message, clear the in-memory query (next
  interaction lazily re-establishes — self-healing); do NOT change DB status.
- `finally`: force `turnActive = false` + emit, clear `backgroundTasks` + emit,
  clear `retry`, clear the turn watchdog.

### `sendUserMessage(sessionId, prompt)` (replaces `runClaudeCommand` + `launchClaude`)

```
await ensureSessionQuery(sessionId)
state.turnActive = true; emit running(true)
persist user message + emit            // same as today
state.input.push({ type:'user', message:{ role:'user', content: prompt }, parent_tool_use_id:null })
```

`runClaudeCommand` is deleted (no backwards-compat). `launchClaude` in `claude.ts`
collapses into `sendUserMessage`; the tool-response fallback uses it too.

### Lifecycle

- `sessions.stop`: `input.close()` (graceful drain) then `query.close()` backstop;
  clear in-memory state; status → `stopped`. If `input.close()` needs awaiting,
  `stopSession` becomes `async` — update `stopAllSessions`'s `Promise.allSettled`
  accordingly (G2; today it wraps a sync `void`).
- `sessions.delete`: same + remove workspace + archive.
- `interrupt`: `query.interrupt()` + the backstop timer (B2), guarded by
  `turnActive`.
  - **`markLastMessageAsInterrupted` must change (B3).** Its "last non-user message
    by `sequence desc`" heuristic breaks once background `task_started` /
    `task_notification` (`system`) or backgrounded-tool messages interleave at the
    top of the sequence. Target the last **main-agent** message instead —
    `parent_tool_use_id == null` and not a background/system task message — so the
    interrupt marker lands on the turn that was actually interrupted.
- graceful shutdown (`stopAllSessions`): `input.close()` + `query.close()` for every
  session, ordered as in `sessions.stop`.

### AskUserQuestion / ExitPlanMode under persistence (B4)

The parked-promise model is unchanged, but two assumptions must be reconciled:

- **`canUseTool` running toggle vs. message-derived `turnActive`.** Today
  `canUseTool` emits `running(false)` while a question is parked, then `running(true)`
  after. Under the message-derived `turnActive` a parked question produces no
  messages, so `turnActive` would stay `true`. DESIGN already makes answer controls
  **DB-derived** (a `tool_use` with no `tool_result`), not running-derived, so the UI
  does not depend on the toggle. Decision: **drop the `running(false)/true` toggle in
  `canUseTool`** and let `turnActive` remain true while parked (the turn genuinely is
  still in progress). Audit confirms nothing else consumes that toggle.
- **`submitLiveToolResponse` polls on `state.isRunning`.** Repoint it at "the query
  is live" (`state.query != null`), not `turnActive` — a parked question can be
  answered whenever the query exists, independent of turn activity. The live path
  now almost always succeeds (query stays alive); the synthetic-tool-result fallback
  in `submitToolResponse` triggers only after stop / crash / restart.

### Background task controls

Stop interrupts the main turn only. Add a per-task control backed by
`query.stopTask(taskId)` so a runaway background subagent can be stopped from the UI
(surfaced next to each entry in the background indicator). `query.backgroundTasks()`
can reconcile the in-memory set against the SDK's view if they drift.

### Server-restart recovery — do NOT force-stop

- **Remove** `markAllSessionsStopped`; running sessions stay `running` across
  restart. DB `status: running` means "user wants this live & resumable," not
  "query in memory." Spell out the coupling (G1): `reconcileSessions` in
  `session-reconciler.ts` is the only thing `instrumentation.node.ts` calls on boot
  and it logs the returned `{ sessionsMarkedStopped }`. Either delete
  `reconcileSessions` and its call site, or repurpose it to a no-op/diagnostic; in
  either case update `instrumentation.node.ts` so it no longer references the old
  return shape. Note: with sessions staying `running`, the graceful-shutdown handler
  (`stopAllSessions`) is the only path that frees subprocesses cleanly; a SIGKILL
  leaves sessions `running` with no in-memory query — correct by design, healed
  lazily on next interaction.
- Next interaction triggers `ensureSessionQuery`, reviving with `resume`. Lazy =
  cheap (no subprocess per idle session on boot).
- Documented limitation: a background task mid-wait when the server died cannot be
  resurrected (its subprocess is gone). Recovery restores the conversation, not
  in-flight background work. On revive after a crash, scan for `task_started`
  blocks with no matching `task_notification` and surface a one-line system note
  ("background task lost to restart") to prevent a phantom-running perception.

## SSE + API (`events.ts`, `sse.ts`, `claude.ts`)

- Keep the `running` channel — now carries `turnActive` (document the meaning shift).
- Add a `background` channel + `SessionStreamEvent` variant
  `{ kind: 'background'; tasks: BackgroundTask[] }`, wired through
  `onSessionEvents` alongside `retry`.
- Add `claude.getBackgroundTasks` query (seed + reconnect resync), parallel to
  `getRetryState`.
- `claude.isRunning` returns `turnActive`. `claude.send` guard becomes "reject if
  `turnActive`" (not "if anything running") — a send is allowed while only
  background tasks run.
- Add `claude.stopBackgroundTask({ sessionId, taskId })` → `query.stopTask(taskId)`.
- Background/running stay latest-value (refetched on reconnect); no new
  resume-token logic.

## Frontend

- `useClaudeState.ts`: expose `turnActive` (from `isRunning`) and add
  `backgroundTasks` / `backgroundActive` (new query + stream channel). Mirror the
  `retry` wiring.
- `useSessionStream.ts`: fan the new `background` event into the
  `getBackgroundTasks` cache (one case alongside `retry`).
- `PromptInput.tsx`: gate textarea/Send on `turnActive` only; background activity
  must not touch them.
- **`VoiceControlPanel.tsx` (G3): also gate its Send/mic on `turnActive`**, not the
  conflated running state — otherwise voice users still can't send during background
  work, defeating the goal. Easy to miss; it has its own `isRunning` prop.
- `ClaudeStatusIndicator`: current props are `{ isRunning, containerStatus, retry }`;
  **add a `backgroundTasks`/`backgroundActive` prop (G4)**. Render "Claude is
  working…" when `turnActive`, plus a separate non-blocking "N background task(s)
  running" line (with `stopTask` controls) when `backgroundActive` (both can be true).
- Working/notification: `useWorkingIndicator` + header logo (`working-context`)
  reflect `turnActive || backgroundActive`; `useWorkCompleteNotification` stays on
  `turnActive` (fires at turn end, unchanged).
- `session/[id]/page.tsx`: the local `isClaudeRunning` feeds many consumers — audit
  each. Input gating, Stop, `VoiceControlPanel`, and `ClaudeStatusIndicator` use
  `turnActive`; working-indicator/logo use `turnActive || backgroundActive`; the
  voice auto-read rising/falling-edge effect stays on `turnActive` (confirm
  `backgroundActive` flicker never reaches it).

## Settings binding (behavior change)

`env` / `systemPrompt` are fixed at query construction, so editing those won't take
effect until the session is restarted (Stop→Start rebuilds with fresh settings).
This is a real regression vs. today (every prompt rebuilds). Mitigations:

1. Document it; `sessions.start` always rebuilds.
2. Apply `model` changes live via `query.setModel()` and **MCP changes via
   `query.setMcpServers()`** (S1) when `boundSettings` differs on the next `send`,
   narrowing the regression to `env` / `systemPrompt` only.

## Testability (per CLAUDE.md)

- Pure `reduceSessionMessage` — exhaustive unit tests incl. `parent_tool_use_id`
  discrimination (a subagent assistant message must NOT set `turnActive`), all
  `result` subtypes, task add/remove, retry.
- `createPushable` — unit tests for await-when-empty, ordering, close-returns.
- Injectable query factory: `runSessionLoop` takes its message iterable from a
  `createQuery` seam. Tests feed a scripted `AsyncIterable<SDKMessage>`
  (user→assistant→task_started→result→…→task_notification→assistant→result)
  against real in-memory SQLite and assert DB rows, sequences, and emitted SSE
  events — no real SDK/network. Exercises the exact waiter scenario.

## Removals

`runClaudeCommand`, `launchClaude`, `markAllSessionsStopped` (+ its call in
`session-reconciler.ts`), the teardown-on-`result` logic.

## Commit-sized chunks

1. **SDK spike (hard gate)** proving (a) streaming input + `resume`, (b)
   interrupt-emits-terminal-result behavior, (c) `task_notification` delivery while
   idle AND agent auto-continue. Throwaway; document findings. Nothing below merges
   until (a)+(c) hold.
2. `createPushable` + `reduceSessionMessage` (pure, incl. turn-scoped retry-clear and
   `parent_tool_use_id` discrimination) + unit tests.
3. `ensureSessionQuery` (with `establishing` finally-clear) / `runSessionLoop` (with
   sequence collision-retry + turn watchdog) / `sendUserMessage`; delete
   `runClaudeCommand`; rewire `claude.ts` + `sessions.ts`. Loop integration test
   (synthetic SDK stream + SQLite).
4. Two-axis status: `background` SSE channel, `getBackgroundTasks`,
   `isRunning`=turnActive, send guard; `stopBackgroundTask` endpoint.
5. Interrupt: backstop timer, `markLastMessageAsInterrupted` retargeting,
   `submitLiveToolResponse`/`canUseTool` reconciliation (B2/B3/B4).
6. Restart recovery: remove `markAllSessionsStopped`, update
   `session-reconciler.ts` + `instrumentation.node.ts`, lazy revive, "task lost to
   restart" note; idle reaper with turn/background/pendingInput guards.
7. Frontend wiring (`useClaudeState`/`useSessionStream`/`PromptInput`/
   `VoiceControlPanel`/`ClaudeStatusIndicator`/page + working/notification keying +
   per-task stop control).
8. Settings binding: live `setModel` + `setMcpServers`; document rebind-on-restart
   caveat.
9. `doc/DESIGN.md` (incl. Known Limitations) + `doc/architecture.d2`.

## Open questions / risks

1. Streaming input + `resume` compatibility, and agent auto-continue after
   `task_notification` (assumptions #1 and #3) — **spike first, hard gate.**
2. One subprocess per running session now persists while idle. Add a configurable
   idle reaper that closes the query after N minutes — but it must **never reap while
   `turnActive`, `backgroundActive`, OR a `pendingInput` (parked AskUserQuestion) is
   set** (G6), else we kill in-flight work or a pending interaction. Lazily revivable.
3. Does `interrupt()` also kill background tasks? Likely not (independent) — verify
   in the spike. Background tasks are stopped via the dedicated `stopTask` control
   (now in scope, see "Background task controls"), not via interrupt.
4. Settings immediacy regression for `env`/`systemPrompt` — acceptable with
   mitigations above (model + MCP applied live).

## Known limitations (document in DESIGN.md)

- A background task mid-wait when the server is SIGKILLed cannot be resurrected;
  recovery restores the conversation, not in-flight background work.
- **Concurrent interactive tool calls:** the model parks a single `pendingInput` and
  _supersedes_ (rejects) an earlier one. With long-lived background subagents, two
  subagents calling `AskUserQuestion` concurrently is more likely than before, and the
  supersede would kill a legitimately-waiting subagent's question. Out of scope to
  fully fix now (would need a keyed map of pending inputs + multi-question UI), but
  record it as a known limitation rather than dismissing it.
  </content>
  </invoke>
