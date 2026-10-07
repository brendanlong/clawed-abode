# Claude Sessions (SDK Integration)

Implementation: [`src/server/services/claude-runner.ts`](../src/server/services/claude-runner.ts) orchestrates; module ownership is in [`src/server/services/CLAUDE.md`](../src/server/services/CLAUDE.md). Pure logic (unit-tested): [`src/lib/live-turn.ts`](../src/lib/live-turn.ts), [`src/lib/session-status.ts`](../src/lib/session-status.ts), [`src/lib/session-scope.ts`](../src/lib/session-scope.ts), [`src/lib/token-estimation.ts`](../src/lib/token-estimation.ts).

Everything below about turn status, delivery and interrupts is implemented by the `reduceLiveTurn` reducer in `live-turn.ts` (the single-writer rule is in the services `CLAUDE.md`).

## Persistent Streaming Query

Each session has **one long-lived `query()` in streaming-input mode** (the prompt is a pushable `AsyncIterable`, [`src/lib/pushable.ts`](../src/lib/pushable.ts)). It is established by `ensureSessionQuery` (idempotent and coalesced; the in-flight promise clears in `finally` so a failed establish can retry), stays alive across turns and idle periods, and is torn down only on stop / delete / shutdown / fatal error.

**Running means reachable.** A `running` session gets its query without waiting for a prompt — at the end of setup, on Start, when the rate-limit pause releases it, and for all running sessions (concurrently) at boot — because another session can only message a CLI that is up ([Cross-Session Messaging](#cross-session-messaging)). The cost is an idle CLI process (~260 MB) per running session; Stop is how to free one. `reviveSession` skips a held session and one whose workspace is gone (the CLI would only fail into its transcript). Establishment itself refuses a session that is no longer `running`, since Stop and Delete tear down memory before writing the status.

**Why:** background tasks (`run_in_background` subagents, `Monitor` watches, backgrounded `Bash`) deliver their `task_started` / `task_notification` messages later in the same stream — and when a task settles, the main agent autonomously continues in a new turn — but only while the stream stays open. A per-prompt query closed the stream at each `result`, killing every waiter.

Revival uses `options.resume`. **The `cwd` must be stable across a resume** — Claude Code keys sessions by project dir — so revival always uses the session's persistent `workingDir`.

**Resume the CLI's current conversation, not `Session.id`.** A query starts its conversation under `Session.id`, but `/clear` makes the CLI switch to a new conversation id mid-stream (announced by a `system/init`). The loop records every init's id on `Session.claudeSessionId` and revival resumes that; resuming `Session.id` would silently restore the cleared context and drop everything since. A null `claudeSessionId` means no transcript exists, so the query starts fresh — never infer one from app-side `Message` rows, which can exist without the CLI ever writing a transcript (a first prompt parked by a rate-limit pause, an error from a query that died before init); resuming an unwritten id fails every retry with "No conversation found".

There is deliberately **no idle reaper and no status timers**: the server cannot distinguish a hung turn from a slow one, so recovery is user-driven and deterministic (interrupt, or the header Stop, which closes the query and forces the status flags off in the loop's `finally`). A persistent subprocess per live session is fine for a single-user host.

## Two-Axis Status

"Is Claude busy?" is two independent facts, both derived purely from the message stream by `reduceSessionMessage` and held in memory (lost on restart, re-derived by the revived stream):

- **`turnActive`** — the main agent is generating. Driven by the **stream**, not the turn `result`: a top-level `message_start` sets it, a top-level `message_delta` with a terminal `stop_reason` clears it (`result` also clears it as a safety net, and covers an interrupt's `error_during_execution`). Keying off `result` would be wrong because a background subagent keeps the parent turn open — the SDK defers the `result` until the child settles, long after the main agent finished generating.
- **Background tasks** — replaced wholesale by each `system/background_tasks_changed` (the SDK's level signal), never by pairing `task_started`/`task_notification` edges, so a missed edge can't leave a stale task. The level is per CLI process and nothing is sent at startup, so the set is reset whenever the query loop exits. `subagentType` exists only on `task_started`, so the reducer keeps that one field from the edge. Per-task ✕-stop calls `query.stopTask`; the next level payload clears it. This axis is **indicator-only and never gates input** — a prompt sent while a subagent runs is answered in a turn that interleaves with it.

**Tasks with no knowable end state are excluded from the busy axis** (`taskHasEndState`): SDK-flagged `ambient` tasks, and `local_bash` tasks — backgrounded Bash (may be a permanent daemon) and every `Monitor` watch, which the CLI runs as `local_bash`. The SDK does _not_ flag a `persistent: true` Monitor as ambient, so the `local_bash` check is what keeps it from pinning the session "background" forever. Excluded tasks are still listed and stoppable. Accepted imperfection: a _finite_ backgrounded Bash or deadline-bounded Monitor is also excluded, so the session reads "waiting" while one runs.

**Ephemeral retry state**: `api_retry` messages never reach the transcript, but the current retry state streams over the `retry` SSE channel (parsed by `parseRetryState`); any other message clears it.

## Sends Are Immediate

The composer is never disabled and the server never holds a message back. Every prompt is persisted and pushed into the streaming query the instant it arrives, whatever the agent is doing — **the CLI folds a mid-turn message into the running turn at the next tool-result boundary**, so a "btw, also…" lands in seconds instead of waiting for the agent to go idle.

The only wait left is the CLI's own, and it reports it: each pushed message carries a `uuid`, and the CLI answers with `command_lifecycle` messages, where **`started` is the moment the agent reads it**. Until then the message id rides the `pending` SSE channel and the transcript marks that bubble "Sending…". The type is absent from the SDK's `SDKMessage` union, so it is Zod-parsed rather than typed, and `classifyMessage` skips it explicitly — otherwise it falls through the exhaustive switch's unknown-type default and renders as a system bubble.

The `running` event is `turnActive || inFlight.size > 0` (`isRunning`). The second clause exists because a message the CLI _can't_ fold into the running turn gets a fresh turn instead, and the whole `result` → `started` → `message_start` stretch in between — full model latency — would otherwise blip the composer idle for work about to continue. That is also why an entry outlives `started`: it is retired at the turn's `message_start`, once `turnActive` can carry the state — or at its `result`, for a turn that ends without one.

**No in-flight entry may linger forever** — one that does pins the composer "working" with no way back. Retirement is therefore never conditional on the CLI reporting anything: a top-level `result` retires an entry that has already survived one turn boundary, and on a CLI that reports no lifecycle at all (`commandLifecycleSeen`) the first boundary retires it, since there is nothing to wait for. `command_lifecycle` is undocumented, so this guard stays even though the bundled CLI sends it. Deliberately not time-based.

**Stop cancels what the agent hasn't read.** `interrupt()` alone is not enough: the SDK runs a still-queued message as its own turn the instant the interrupt lands. Stop (and the rate-limit pause, through the shared `abortTurn`) therefore calls `query.cancelAsyncMessage` per un-started uuid **before** interrupting — the abort is what wakes the CLI's drain loop, so cancelling afterwards loses the race every time (observed end-to-end; the SDK's own `still_queued` docs say a post-interrupt probe "always loses the race against the drain loop"). A command the CLI already dequeued reports `cancelled: false` and is left alone, bubble included, because the agent did read it.

A recalled message's bubble is **deleted** (`message_removed`) — it describes something that never happened. That makes the composer the only surviving copy, so the recalled text and attachments are returned to the caller and merged into it ahead of anything typed since (`mergeCancelledText`); both `PromptInput` and `VoiceControlPanel` must do this. Contrast the send-_failure_ path, which leaves a newer draft alone — there the message is still in the transcript, so skipping the restore loses nothing.

`cancelAsyncMessage` exists at runtime but is missing from the SDK's `Query` type, so it is reached through a type cast.

Known limitation: `message_removed` is live-only — it carries no sequence, so it isn't replayed on SSE resume and the client doesn't refetch history on reconnect. A client that is disconnected while a _different_ tab hits Stop keeps showing the deleted bubble until it reloads. The DB stays correct; only that client's cache is stale.

## Interactive Tools (AskUserQuestion / ExitPlanMode)

`canUseTool` parks a promise keyed by the SDK's `toolUseID`; every other tool auto-approves (`bypassPermissions`). The parked promise dies with the query (stop, delete, restart), but the `tool_use` block lives in the DB forever — so **the server is authoritative and the UI stays dumb**: answer controls show whenever a `tool_use` block has no matching `tool_result`, purely DB-derived, never consulting running-state. Server routing (`submitToolResponse` in [`src/server/routers/claude.ts`](../src/server/routers/claude.ts)):

1. **Live** — resolve the parked promise; the current turn continues (the common path; a short poll covers the answer racing the SDK's `canUseTool` call).
2. **Fallback** — no live promise: persist a synthetic `tool_result` (pairing it so the controls disappear) and resume the session with a prompt built from the answer (`formatToolResponsePrompt`).
3. **Already** — the synthetic result's message id derives from the `toolUseId`, so a double submit hits the unique constraint and is a no-op; a double answer never starts two turns.

An `ExitPlanMode` "request changes" resolves `deny` with the feedback so Claude revises in place.

Known limitation: only one `pendingInput` parks at a time; a second interactive tool call supersedes (rejects) the first.

## Needs You

The only notification is the agent asking for the user: the built-in `notify_user` tool ([`settings.md`](settings.md#built-in-tools)), or an AskUserQuestion / ExitPlanMode parking for an answer. Either sets `Session.attentionAt` and a one-line `attentionSummary` ([`session-attention.ts`](../src/server/services/session-attention.ts)), shown in the session list, and emits an `attention` list event that the notifier turns into a desktop notification.

**Why the agent says so, rather than the server inferring it from turn state:** a turn ending idle is ambiguous. The agent may be done, or waiting on a Monitor, a backgrounded command, or another session's reply, none of which the busy axes can see (see [Two-Axis Status](#two-axis-status)). Only the agent knows. We have it declare "I have something for you" rather than "I'm still waiting", because it says the former at the moment it writes its report. If it forgets, the user is back to scanning the list. Notifying on every idle turn end was too noisy to be useful.

The flag lives in the DB, not live state, so it survives a restart. It clears on any user interaction (`bumpSessionActivity`) and whenever the session's page is visible (`sessions.markSeen`), i.e. once seen, not once answered.

Client side, `AttentionNotifier` (mounted once in `Providers`, fed by the global SSE stream) notifies for **any** session except the one actively watched — its page open _and_ the tab visible (pure helpers in [`src/lib/attention-notification.ts`](../src/lib/attention-notification.ts)).

## Cross-Session Messaging

Sessions message each other with the CLI's built-in `ListAgents` / `SendMessage` tools over a per-process local socket; nothing in the app relays them. A message to an idle session starts a turn there on its own.

The CLI registers under `CLAUDE_CODE_SESSION_NAME`, set from `Session.agentName`; left unset, it picks a random suffix on every process start, so an address would not survive a restart. The name is generated once ([`agent-name.ts`](../src/server/services/agent-name.ts)): 2–3 words from Haiku plus a session-id suffix, since sibling sessions given the same prompt would otherwise get the same name. Generation starts at creation so it overlaps the clone, and it is best-effort: any failure falls back to the repo name or an id prefix, and establishment never waits on more than one short request.

How the incoming messages reach the transcript is under Classification in [`messages-and-sse.md`](messages-and-sse.md).

## Process Reaping (cgroup)

Daemons an agent starts (Postgres, Redis, dev servers) double-fork and escape the process tree, so killing the launching command's tree leaks them on the shared host. We don't touch them mid-session — an agent may legitimately keep a service running — we only guarantee **everything a session spawned dies when the session ends**. Implementation: [`src/server/services/session-cgroup.ts`](../src/server/services/session-cgroup.ts), covered by `session-cgroup.integration.test.ts`.

- The SDK spawns each session's `claude` CLI subprocess through a launcher script (`SESSION_SCOPE_LAUNCHER`, written to app-owned `~/.clawed/` mode `0700` — not symlink-clobberable, `/tmp`-reaped world-writable space) that `exec`s the real CLI under `systemd-run --user --scope`, putting the whole session tree in one cgroup. Teardown (stop/delete/shutdown _and_ any query-loop exit) runs `systemctl --user stop <scope>`, which kills the tree regardless of double-forking. Delete waits for that stop before removing the workspace — otherwise a surviving daemon (e.g. `next dev`) recreates files after the `rm`, orphaning the directory. A short `TimeoutStopSec` bounds SIGTERM-ignoring processes.
- **Fail-to-unwrapped at spawn time**: the launcher probes with a throwaway scope first and `exec`s the CLI directly if scopes don't work — `exec` can't recover after the fact, and the launch environment can differ from or drift after app start (e.g. the systemd user session dying on logout). A host without usable user scopes degrades rather than hard-failing sessions.
- Scope names carry a per-establishment nonce (a stop→start can't collide with a not-yet-torn-down scope) and are persisted on `Session.sessionScope`, cleared on clean teardown, so a crash-restart reaps orphans **by exact recorded name only** (`reapOrphanedSessionScopes` at startup). **Never reap by `clawed-session-*` glob**: a glob sweep from any co-tenant instance (a dev server, a test) cgroup-kills every live production session at once. Corollary invariant: two live instances must not share a `DATABASE_URL` (they'd reap each other's scopes by exact name — and a shared DB already breaks the single-instance model).

Accepted gaps: an untrappable SIGKILL leaves scopes until the next startup reap; and a transient SDK error + revive reaps daemons the agent had started, so its services vanish between turns with no signal (the tree is gone anyway once the CLI dies).

## Cost & Context Estimation

Served by `claude.getTokenUsage` from running totals in `SessionUsage`, folded in by `insertMessage` as each result and system/init arrives ([`session-usage.ts`](../src/server/services/session-usage.ts)), so a read never rescans the transcript — the client refetches on every message that can move the numbers. The pure logic is in [`src/lib/token-estimation.ts`](../src/lib/token-estimation.ts). It relies on result-message semantics **verified empirically against real sessions** — the two field families have different scopes:

- Top-level `usage` is **per-turn** → summable across results.
- `total_cost_usd` / `modelUsage` are **cumulative since the query process started** — with a persistent query one process spans many turns, so summing double-counts roughly quadratically. Cost is aggregated by segmenting results into query processes (cumulative cost is monotone within a process, so a drop marks a reset) and summing each segment's final value. A reset is masked only if a new process's first turn costs more than the entire previous process — a slight undercount, acceptable for an indicator.

Context % is the _current_ window fill, not total consumption: the latest **top-level** assistant message's `input + cache_read + cache_creation + output` tokens over `modelUsage[mainModel].contextWindow` (subagents run in their own smaller context and are skipped; the entry matching the main model wins, falling back to the largest, then 200k).
