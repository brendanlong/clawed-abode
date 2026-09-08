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

## Two Signals

- **`rate_limit_event`** on a session's stream — the only signal that reports
  `rejected`. Read in the query loop and folded into the shared state, whichever
  session's stream it happened to arrive on.
- **The SDK's structured `/usage` snapshot**, polled at turn boundaries
  ([`rate-limit-usage.ts`](../src/server/services/rate-limit-usage.ts)). The event
  only fires when the subscription's rate-limit info _changes_, so it can't be
  relied on for a utilization figure while a window is merely filling — and the
  threshold pause needs a number. A turn boundary is the right moment to check
  because pausing there costs no in-progress work. Throttled globally; the method
  is experimental, so it is feature-detected and its response Zod-parsed.

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

A send to a paused session still writes its transcript bubble (the user sees what
they sent, badged "queued") but never establishes a query. Only the payload needed
to push it later lives in `QueuedPrompt`; that is why release re-pushes rather than
re-persists.

**Releasing** nudges before draining. A rejection cuts a turn off wherever it was,
so a session that was mid-turn when one landed is flagged `resumeAfterRateLimit`
and sent `RATE_LIMIT_RESUME_PROMPT` first; then its queued prompts are re-pushed in
order. Each push re-reads the input channel, so a query that dies mid-drain leaves
the rest queued for the next attempt rather than dropping it.

**Stop is the way out.** `interruptClaude` empties the queue, deletes those bubbles
and returns the text to the composer (the same recall path Stop already used for
in-flight prompts), and withdraws a pending resume nudge — a user stopping is a
clear signal they don't want the session picking work back up on its own. This
matters because a paused session has no live turn for Stop to act on otherwise.

## UI

The pause never gates the composer — sends always succeed, they just queue. The
banner above the composer (`RateLimitPauseBanner`, rendered by `PromptInput`)
explains where they went and offers the only way to take them back. Per-session
overrides live in the session settings sheet; global defaults and the live window
readings are in Settings → General.
