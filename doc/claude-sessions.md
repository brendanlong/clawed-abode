# Claude Sessions (SDK Integration)

Implementation: [`src/server/services/claude-runner.ts`](../src/server/services/claude-runner.ts). Pure logic (unit-tested): [`src/lib/session-status.ts`](../src/lib/session-status.ts), [`src/lib/queued-message.ts`](../src/lib/queued-message.ts), [`src/lib/session-scope.ts`](../src/lib/session-scope.ts), [`src/lib/token-estimation.ts`](../src/lib/token-estimation.ts).

## Persistent Streaming Query

Each session has **one long-lived `query()` in streaming-input mode** (the prompt is a pushable `AsyncIterable`, [`src/lib/pushable.ts`](../src/lib/pushable.ts)). It is established lazily (`ensureSessionQuery` — idempotent and coalesced; the in-flight promise clears in `finally` so a failed establish can retry), stays alive across turns and idle periods, and is torn down only on stop / delete / shutdown / fatal error.

**Why:** background tasks (`run_in_background` subagents, `Monitor` watches, backgrounded `Bash`) deliver their `task_started` / `task_notification` messages later in the same stream — and when a task settles, the main agent autonomously continues in a new turn — but only while the stream stays open. A per-prompt query closed the stream at each `result`, killing every waiter.

Revival uses `options.resume`. **The `cwd` must be stable across a resume** — Claude Code keys sessions by project dir — so revival always uses the session's persistent `workingDir`.

There is deliberately **no idle reaper and no status timers**: the server cannot distinguish a hung turn from a slow one, so recovery is user-driven and deterministic (interrupt, or the header Stop, which closes the query and forces the status flags off in the loop's `finally`). A persistent subprocess per live session is fine for a single-user host.

## Two-Axis Status

"Is Claude busy?" is two independent facts, both derived purely from the message stream by `reduceSessionMessage` and held in memory (lost on restart, re-derived by the revived stream):

- **`turnActive`** — the main agent is generating. Driven by the **stream**, not the turn `result`: a top-level `message_start` sets it, a top-level `message_delta` with a terminal `stop_reason` clears it (`result` also clears it as a safety net, and covers an interrupt's `error_during_execution`). Keying off `result` would be wrong because a background subagent keeps the parent turn open — the SDK defers the `result` until the child settles, long after the main agent finished generating.
- **Background tasks** — a map driven by `task_started` (add) / `task_notification` (remove), with per-task ✕-stop (`claude.stopBackgroundTask` → `query.stopTask`, then optimistic removal so the ✕ also clears phantoms whose terminal notification was dropped; a late notification is a no-op). This axis is **indicator-only and never gates input** — a prompt sent while a subagent runs is answered in a turn that interleaves with it (verified: `scripts/spike-concurrent-send.ts`).

**Tasks with no knowable end state are excluded from the busy axis** (`taskHasEndState`): backgrounded Bash (`local_bash` — may be a permanent daemon) and `persistent: true` Monitors may never emit a `task_notification`, and counting them would pin the session "background" and suppress the finished notification forever. They're still tracked and stoppable in the task list. Detecting a persistent Monitor needs a linkage step: the reducer remembers `persistent: true` Monitor `tool_use` ids and consumes them when the matching `task_started` arrives (the flag lives only on the tool call's input). Accepted imperfection: a _finite_ backgrounded Bash is also excluded, so a turn ending while one runs notifies early — self-correcting, since its settle makes the main agent continue and that turn's end notifies again.

**Ephemeral retry state**: `api_retry` messages never reach the transcript, but the current retry state streams over the `retry` SSE channel (parsed by `parseRetryState`); any other message clears it.

Known limitation: a task lingers in the map if neither a `task_notification` nor a user ✕ happens (notably `killed` tasks emit no notification); it clears on query teardown. Accepted — indicator-only, so the cost is a stale count, never a stuck composer.

## Queued Sends ("btw mode")

The composer is never disabled. **The server owns the queue decision** — the client always calls `claude.send` and never routes on its own view of turn state, because a replicated client copy can lag or seed stale (the earlier client-side queue silently mis-sent when the two disagreed). `sendUserMessage` decides atomically against the in-memory `turnActive`:

- **Idle** → persist and push into the query (a turn starts), draining any leftover queued messages ahead of it in order, combined into one turn.
- **Turn active** → hold in the in-memory queue, surfaced over the `queued` SSE channel as removable bubbles. **Not persisted until flush** — that deferral is exactly what makes ✕-removal (`claude.cancelQueued`, idempotent) possible.

Flush happens only on a **natural** turn end: queued messages are persisted as individual bubbles and pushed combined into one turn. `awaitingFlushTurn` holds `turnActive` continuously true across the handoff — a false→true blip would fire the "Claude finished" notification / voice auto-read mid-flush. **Interrupt skips the flush** (`interruptRequested`) so hitting Stop doesn't instantly fire the queue as a fresh turn; it also clears `awaitingFlushTurn` up front, because an interrupt during a flush handoff produces a `result` with no preceding `message_start`, which would otherwise pin the composer "working".

The queue is bounded (`MAX_QUEUED_MESSAGES`; the Queue button disables when full). A failed send must never lose composer text: `PromptInput` and `VoiceControlPanel` both use the promise-returning send path and restore the text/attachments (or transcript) on rejection unless the user already started a new message.

Known limitation: the queue is in-memory; a stop/restart before flush drops it (like other ephemeral session state).

## Interactive Tools (AskUserQuestion / ExitPlanMode)

`canUseTool` parks a promise keyed by the SDK's `toolUseID`; every other tool auto-approves (`bypassPermissions`). The parked promise dies with the query (stop, delete, restart), but the `tool_use` block lives in the DB forever — so **the server is authoritative and the UI stays dumb**: answer controls show whenever a `tool_use` block has no matching `tool_result`, purely DB-derived, never consulting running-state. Server routing (`submitToolResponse` in [`src/server/routers/claude.ts`](../src/server/routers/claude.ts)):

1. **Live** — resolve the parked promise; the current turn continues (the common path; a short poll covers the answer racing the SDK's `canUseTool` call).
2. **Fallback** — no live promise: persist a synthetic `tool_result` (pairing it so the controls disappear) and resume the session with a prompt built from the answer (`formatToolResponsePrompt`).
3. **Already** — the synthetic result's message id derives from the `toolUseId`, so a double submit hits the unique constraint and is a no-op; a double answer never starts two turns.

An `ExitPlanMode` "request changes" resolves `deny` with the feedback so Claude revises in place.

Known limitation: only one `pendingInput` parks at a time; a second interactive tool call supersedes (rejects) the first.

## "Claude Finished" Notification

`emitClaudeFinished` fires only on a **natural turn end that leaves the session fully idle**: `turnActive` flipped off, not interrupted, and no end-state background task running. Why not the `running: false` edge: that also fires on interrupt/stop/delete and would notify for work the user cancelled. Why turn-end rather than background-drain: a settling task autonomously continues the main agent, and _that_ turn's end is the real "done" (firing on the drain would notify twice). Residual edge, accepted: a task settling with no continuation leaves no finished signal — no spurious notification beats no missed one.

Client side, `WorkCompleteNotifier` (mounted once in `Providers`, fed by the global SSE stream) notifies for **any** session except the one actively watched — its page open _and_ the tab visible (pure helpers in [`src/lib/work-complete-notification.ts`](../src/lib/work-complete-notification.ts)).

## Process Reaping (cgroup)

Daemons an agent starts (Postgres, Redis, dev servers) double-fork and escape the process tree, so killing the launching command's tree leaks them on the shared host. We don't touch them mid-session — an agent may legitimately keep a service running — we only guarantee **everything a session spawned dies when the session ends**. Implementation: [`src/server/services/session-cgroup.ts`](../src/server/services/session-cgroup.ts), covered by `session-cgroup.integration.test.ts`.

- The SDK spawns each session's `claude` CLI subprocess through a launcher script (`SESSION_SCOPE_LAUNCHER`, written to app-owned `~/.clawed/` mode `0700` — not symlink-clobberable, `/tmp`-reaped world-writable space) that `exec`s the real CLI under `systemd-run --user --scope`, putting the whole session tree in one cgroup. Teardown (stop/delete/shutdown _and_ any query-loop exit) runs `systemctl --user stop <scope>`, which kills the tree regardless of double-forking. A short `TimeoutStopSec` bounds SIGTERM-ignoring processes.
- **Fail-to-unwrapped at spawn time**: the launcher probes with a throwaway scope first and `exec`s the CLI directly if scopes don't work — `exec` can't recover after the fact, and the launch environment can differ from or drift after app start (e.g. the systemd user session dying on logout). A host without usable user scopes degrades rather than hard-failing sessions.
- Scope names carry a per-establishment nonce (a stop→start can't collide with a not-yet-torn-down scope) and are persisted on `Session.sessionScope`, cleared on clean teardown, so a crash-restart reaps orphans **by exact recorded name only** (`reapOrphanedSessionScopes` at startup). **Never reap by `clawed-session-*` glob**: a glob sweep from any co-tenant instance (a dev server, a test) cgroup-kills every live production session at once — this caused a real mass-kill incident. Corollary invariant: two live instances must not share a `DATABASE_URL` (they'd reap each other's scopes by exact name — and a shared DB already breaks the single-instance model).

Accepted gaps: an untrappable SIGKILL leaves scopes until the next startup reap; and a transient SDK error + revive reaps daemons the agent had started, so its services vanish between turns with no signal (the tree is gone anyway once the CLI dies).

## Cost & Context Estimation

`estimateTokenUsage` ([`src/lib/token-estimation.ts`](../src/lib/token-estimation.ts)), served by `claude.getTokenUsage`. It relies on result-message semantics **verified empirically against real sessions** — the two field families have different scopes:

- Top-level `usage` is **per-turn** → summable across results.
- `total_cost_usd` / `modelUsage` are **cumulative since the query process started** — with a persistent query one process spans many turns, so summing double-counts roughly quadratically. Cost is aggregated by segmenting results into query processes (cumulative cost is monotone within a process, so a drop marks a reset) and summing each segment's final value. A reset is masked only if a new process's first turn costs more than the entire previous process — a slight undercount, acceptable for an indicator.

Context % is the _current_ window fill, not total consumption: the latest **top-level** assistant message's `input + cache_read + cache_creation + output` tokens over `modelUsage[mainModel].contextWindow` (subagents run in their own smaller context and are skipped; the entry matching the main model wins, falling back to the largest, then 200k).
