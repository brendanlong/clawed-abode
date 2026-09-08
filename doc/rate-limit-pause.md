# Rate-Limit Pause

Park work when a Claude subscription usage window fills, and release it when the
window resets — so a batch of prompts queued on a Monday paces itself across the
week instead of failing turns once the 5-hour window runs out.

Pure logic: [`src/lib/rate-limit.ts`](../src/lib/rate-limit.ts). State and
scheduling: [`rate-limit-state.ts`](../src/server/services/rate-limit-state.ts).
The durable queue: [`prompt-queue.ts`](../src/server/services/prompt-queue.ts).
Orchestration lives in `claude-runner`, which subscribes to state changes.

## Readings Are Shared, Policy Is Per-Session

There is one subscription, so window state is **account-wide**: a `RateLimitWindow`
row per window (`five_hour`, `seven_day`, …), holding utilization, whether the API
is refusing requests, and when it resets. Rows are persisted because a restart
mid-pause must not release queued work into a window that is still exhausted.

What a reading _means_ is per-session. `resolvePausePolicy` resolves each field
independently, session override → global default, so one session can park at 50%
of the 5-hour window while another runs on past the limit into overage credits.
Both live on the session row (`rateLimitPauseEnabled`, `rateLimitPauseThreshold`,
null = inherit) and on `GlobalSettings`.

## Reading the Events

Everything comes from `rate_limit_event` messages, folded into the shared state
from whichever session's stream they arrive on. The SDK's `SDKRateLimitInfo` type
is thin enough to be misleading, so the parsing was written against the ~8.8k real
events in this app's production database. Three things that only the data tells
you:

- **`utilization` is a fraction, not a percentage.** 0.78 means 78%. Compared
  against a 0-100 threshold it would silently never fire.
- **`unifiedWindows`** — undocumented, absent from the SDK types, first seen in
  September 2026 — carries every window's usage on nearly every event. It is the
  only dependable source of a utilization figure: the top-level `utilization` is
  populated on `allowed_warning` events but null on the plain `allowed` ones that
  are ~87% of the stream, and null on rejections. Without it the threshold has
  nothing to read and only the `rejected` backstop applies.
- **An event states a status for one window but reports usage for several.** Those
  extra readings are _not_ authoritative about refusal, and merging them as though
  they were is a live-fire bug: a routine 5-hour `allowed` event lists the weekly
  window too, and clearing that window's rejection would release the queue into a
  window the API is still refusing — repeatedly. `mergeReading` lets a usage-only
  reading update the numbers while inheriting a live rejection, until either an
  authoritative reading says otherwise or the window rolls over.

Rejections also arrive with `overageStatus: "allowed"` when credits would cover
them. We still pause: a session with pausing on is asking not to spend money past
the plan allowance, and one with pausing off is asking to spend it.

**The threshold applies only to the 5-hour window.** On a weekly window it would
permanently strand the last few percent of the allowance — and spending the week's
budget in full is the point. A weekly window holds only once the API actually
refuses a request.

## Pausing and Releasing

Holds are never stored; `recomputeRateLimitHolds` recomputes the desired state for
every session and converges on it, so a missed or duplicated trigger is harmless.
It runs on a new reading, on a window resetting (a single timer armed for the
earliest active reset), on a policy change, and at startup. It is serialized —
two concurrent runs would race to push the same queued prompt twice.

**Pausing** does not interrupt anything. The live turn is left alone: under a
threshold pause it can still finish, and under a rejection it is already dying.
All the pause does is stop feeding the session — everything the CLI has queued but
not read is recalled into the durable queue, and new sends go there instead.

Recalling a push that the CLI never read has to undo the optimistic `turnActive`
that push set (`clearOptimisticTurn`), or the composer reads "working" for the
whole pause with no message coming that could ever clear it. The same flag keeps
that session out of the resume-nudge snapshot: nothing started, so there is
nothing to continue.

A send to a paused session still writes its transcript bubble (the user sees what
they sent, badged "queued") but never establishes a query. Only the payload needed
to push it later lives in `QueuedPrompt`; that is why release re-pushes rather than
re-persists.

**Releasing** nudges before draining. A rejection cuts a turn off wherever it was,
so a session that was mid-turn when one landed is flagged `resumeAfterRateLimit`
and sent `RATE_LIMIT_RESUME_PROMPT` first; then its queued prompts are re-pushed in
order. The nudge is not user-initiated, so it must not bump `lastActivityAt` — a
window resetting would otherwise reshuffle the whole session list with no user
involved.

Each push re-reads the input channel, so a query that dies mid-drain leaves the
rest queued for the next attempt rather than dropping it, and **claims each row by
deleting it before pushing**: Stop can empty the queue underneath the loop, and
pushing a prompt the user just took back would run cancelled work with no bubble
to show for it.

At startup the readings are restored before anything can drain, but the recompute
itself is not awaited — if the window reset while the server was down the drain
establishes queries, and a slow one must not stall boot. That drain is the one
place a session revives without a user interaction; the queued prompt _is_ the
interaction, just an earlier one.

**Stop is the way out.** `interruptClaude` empties the queue, deletes those bubbles
and returns the text to the composer (the same recall path Stop already used for
in-flight prompts), and withdraws a pending resume nudge — a user stopping is a
clear signal they don't want the session picking work back up on its own. This
matters because a paused session has no live turn for Stop to act on otherwise.
Archiving clears the queue for the same reason: archiving keeps the session row,
so the `onDelete: Cascade` never fires and nothing drains an archived session.

## UI

The pause never gates the composer — sends always succeed, they just queue. The
banner above the composer (`RateLimitPauseBanner`, rendered by `PromptInput`)
explains where they went and offers the only way to take them back. Per-session
overrides live in the session settings sheet; global defaults and the live window
readings are in Settings → General.
