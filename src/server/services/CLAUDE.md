# Server services

Must-know invariants when touching this directory; design details in `doc/claude-sessions.md` and `doc/messages-and-sse.md`.

- Each session has one long-lived streaming `query()` — never revert to per-prompt queries (background tasks need the stream to stay open) and never change a session's `cwd` across a resume (Claude Code keys sessions by project dir).
- **All message inserts go through `insertMessage`** — it assigns sequences atomically in a single statement; never read-then-insert a sequence, and never wrap inserts in interactive transactions (they deadlock under SQLite's single-writer model).
- The server is authoritative for live state (queue routing, interactive-tool answering, editor URL availability); don't make the client route on its own replica of turn state.
- Status is purely event-driven — **no status timers or watchdogs** (the server can't tell a hung turn from a slow one; recovery is user-driven). Every query-loop exit path must clear the live status flags and stop the session's systemd scope.
- Never reap session scopes by `clawed-session-*` glob — only by exact names recorded in this instance's DB. A glob sweep once cgroup-killed every live production session.
- Secrets must never reach the CLI argv (it leaks via journald and `/proc/*/cmdline`) — pass MCP config via the mode-0600 workspace file, not `options.mcpServers`.
- Settings bind at query establishment; only model and MCP servers can be applied live (`query.setModel` / `query.setMcpServers`).
