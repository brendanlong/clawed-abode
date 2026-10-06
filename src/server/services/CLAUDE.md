# Server services

Must-know invariants when touching this directory; design details in `doc/claude-sessions.md` and `doc/messages-and-sse.md`.

- `claude-runner.ts` is the orchestrator only. New logic goes in the module that owns the concern (`agent-env`, `sdk-options`, `in-flight-commands`, `message-store`, `session-commands`, `session-branch-pr`, `session-state`, `session-lifecycle`, `rate-limit-pause`), where it can be unit-tested without booting the query loop. `rate-limit-pause` reaches the runner only through the `PauseRunner` port passed to `initRateLimitPause`, never by importing it.
- Each session has one long-lived streaming `query()` — never revert to per-prompt queries (background tasks need the stream to stay open) and never change a session's `cwd` across a resume (Claude Code keys sessions by project dir).
- **All message inserts go through `insertMessage`** — it assigns sequences atomically in a single statement; never read-then-insert a sequence, and never wrap inserts in interactive transactions (they deadlock under SQLite's single-writer model).
- The server is authoritative for live state (message delivery, interactive-tool answering, editor URL availability); don't make the client route on its own replica of turn state.
- Live turn state (`SessionState.turn`) changes only through the runner's `dispatch` into the pure `reduceLiveTurn` (`src/lib/live-turn.ts`), which emits the SSE channels whose `liveView` changed. Never mutate it or emit `running`/`pending`/`background`/`retry` by hand.
- Status is purely event-driven — **no status timers or watchdogs** (the server can't tell a hung turn from a slow one; recovery is user-driven). Every query-loop exit path must clear the live status flags and stop the session's systemd scope. (The rate-limit pause's reset timer is not an exception: it fires at a deadline the API told us, not at a guess about a stalled turn.)
- Never reap session scopes by `clawed-session-*` glob — only by exact names recorded in this instance's DB. A glob sweep once cgroup-killed every live production session.
- Secrets must never reach a child process's argv (it leaks via journald and `/proc/*/cmdline`) — pass MCP config via the mode-0600 workspace file, not `options.mcpServers`, and the GitHub token via the environment the credential helper reads (`src/lib/git-credentials.ts`), not a token-in-URL clone.
- Settings bind at query establishment; only model and MCP servers can be applied live (`query.setModel` / `query.setMcpServers`).
- Rate-limit holds are **never stored** — `recomputeRateLimitHolds` recomputes and converges (idempotent, serialized). Details: `doc/rate-limit-pause.md`.
