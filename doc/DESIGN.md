# Clawed Abode - Design Document

## Overview

A self-hosted web application providing mobile-friendly access to Claude Code running on a local machine with GPU support. Sessions are persistent (they survive disconnections and server restarts), isolated by per-session git clones, and reached over Tailscale. The server runs as an ordinary user.

This file is the high-level map. Details live in reference docs, loaded on demand:

- [`claude-sessions.md`](claude-sessions.md) — the persistent SDK query, turn/background status, message delivery, interactive tools, cross-session messaging, process reaping, cost estimation
- [`messages-and-sse.md`](messages-and-sse.md) — message classification, storage/pagination, SSE streaming/resume
- [`settings.md`](settings.md) — settings layers, model resolution, proxied (non-Claude) models and GPT agents, secrets, MCP servers
- [`rate-limit-pause.md`](rate-limit-pause.md) — pausing sessions on subscription usage limits and draining when the window resets
- [`security.md`](security.md) — auth, input sanitization, and secret redaction
- [`self-hosting.md`](self-hosting.md) — setup, updating, optional services, and environment variables

## Goals

- Run Claude Code sessions from mobile devices without a terminal
- Access local GPU resources not available in Claude Code Web
- Persistent sessions that survive disconnections
- Clean session lifecycle tied to git clones and cgroups
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
                                                │  ~/worktrees/{sessionId}/        │
                                                │  SQLite (Prisma)                 │
                                                └──────────────────────────────────┘
```

Key decisions:

- **No containers inside the app.** The Claude Agent SDK runs in-process in the Next.js server, and agents use the machine's tools directly. The isolation boundary is the machine itself, so it must be dedicated to this app: the recommended deployment is the whole app in one VM ([#348](https://github.com/brendanlong/clawed-abode/issues/348)), with agents using rootless Podman for their own containers and reaching a GPU, when the VM has none, through a separate sandbox such as gpuc over SSH. Each session's `claude` CLI subprocess runs in its own systemd user scope so everything it spawned can be reaped at session end (see [`claude-sessions.md`](claude-sessions.md)).
- **Isolation is convention-only.** Each session gets its own clone at `~/worktrees/{sessionId}/{repoName}` (no-repo sessions get a bare `~/worktrees/{sessionId}/`), but all sessions share the host user, filesystem, and installed tools, and can see each other's worktrees. Tool calls are gated only by Claude Code's permission mode (auto by default, see [`settings.md`](settings.md#permission-mode)).
- **SQLite + Prisma 7** with the Rust-free `prisma-client` generator (client generated to `src/generated/prisma/`, gitignored; imported via `@/generated/prisma/client`). Schema: [`prisma/schema.prisma`](../prisma/schema.prisma); CLI config: [`prisma.config.ts`](../prisma.config.ts). The database runs in WAL mode (set at boot) because agents read the prod DB with the `sqlite3` CLI, and in rollback-journal mode a long read blocks the server's writes until they fail with `SQLITE_BUSY`.
- **tRPC for the API** ([`src/server/routers/`](../src/server/routers/)); **SSE for all server→client streaming**. Client→server actions are ordinary mutations, so a bidirectional transport (WebSockets) is unnecessary.
- **Single-user password auth** behind Tailscale — see [`security.md`](security.md).
- **Cursor-based pagination everywhere**: messages by per-session `sequence`; session and auth-session lists by a `(timestamp desc, id desc)` keyset, with starred sessions first ([`src/lib/keyset-page.ts`](../src/lib/keyset-page.ts)).
- **Environment is validated once at boot** ([`src/lib/env.ts`](../src/lib/env.ts), called from instrumentation) so a bad variable stops startup instead of the first request that reads it.

## Data Model

The schema ([`prisma/schema.prisma`](../prisma/schema.prisma)) is the source of truth. Non-obvious semantics:

- `Session.lastActivityAt` is bumped only on **user interactions** (sending a prompt, answering a question/plan) — never on assistant/background traffic or lifecycle changes — so the session list orders by where the user last acted and doesn't shuffle while other sessions generate.
- `Session.starred` pins a session above the unstarred ones in the session list (ties ordered as usual, by `lastActivityAt`); archiving clears it and archived sessions can't be starred.
- `Session.pullRequest` is a cached copy of the branch's shared `PullRequest` row, so listing sessions never waits on GitHub (see [`messages-and-sse.md`](messages-and-sse.md)).
- Deleting a session **archives** it: the workspace and the session's private `TMPDIR` ([`session-tmpdir.ts`](../src/server/services/session-tmpdir.ts)) are removed, messages are kept and viewable read-only, and it's excluded from the session list by default.
- "No Repository" sessions use the `__no_repo__` sentinel in `RepoSettings`.

## Session Lifecycle

- **Create** (`sessions.create`) returns immediately with status `creating`; cloning happens in the background, with progress in `statusMessage` pushed over SSE. An optional initial prompt (and attachments, see File Uploads) is sent server-side once the session is running, so it works even if the client disconnects.
- **Interact**: prompts go through the session's persistent streaming query ([`claude-sessions.md`](claude-sessions.md)); a mid-turn send goes straight to the agent.
- **Interrupt** stops only the current turn; the query stays alive. **Stop** closes the query; the worktree stays on disk and **Start** revives it. **Delete** stops the query, removes the workspace, and archives.
- **Status writes are conditional** ([`session-lifecycle.ts`](../src/server/services/session-lifecycle.ts), table in [`session-transitions.ts`](../src/lib/session-transitions.ts)): each transition updates only from its allowed statuses in one statement, so a stop, start, or late-finishing setup can never overwrite a concurrent archive. A failed setup (`error`, no workspace) can only be archived.
- **Running means reachable**: every `running` session's query is up without waiting for a prompt, including after a restart — see [`claude-sessions.md`](claude-sessions.md).

### File Uploads

[`POST /api/upload`](../src/app/api/upload/route.ts) streams one file per request, as the raw body, straight to disk. It is a route rather than a tRPC mutation so bodies aren't base64-inflated through superjson, and raw rather than multipart because `request.formData()` buffers the whole body. Files land in an `uploads/` **sibling of the clone** ([`uploads.ts`](../src/server/services/uploads.ts)), so the agent can read them but they never show up as repo changes. There are deliberately no size or count caps: anyone who can upload can already run arbitrary commands through the agent. Attachment paths are prefixed onto the persisted message text, so the transcript shows exactly what the model saw. New Session page attachments are staged under `~/worktrees/` and claimed by setup before the initial prompt.

### Public Files

Opt-in (`PUBLIC_FILES_PORT` + `PUBLIC_FILES_URL`): a second HTTP server in the same process ([`public-files-server.ts`](../src/server/services/public-files-server.ts)) serves each workspace's `public/` directory (a sibling of the clone, like `uploads/`) at `/{sessionId}/…`, and the system prompt gives each session its directory and URL — so agents hand the user a stable link instead of running their own HTTP server. It is a separate port rather than an app route to give agent-written pages their own origin (see [`security.md`](security.md)). Exposed by [`scripts/expose-public-files-tailscale.sh`](../scripts/expose-public-files-tailscale.sh).

### System Prompt

`DEFAULT_SYSTEM_PROMPT` in [`src/lib/system-prompt.ts`](../src/lib/system-prompt.ts) — the prompt text states its own rationale: the user has no local file access (so commit/push/PR is mandatory), and every session shares one host user with the app server (so kill by PID or a `--cgroup`-scoped pattern, never by name).

### Built-in Tools

Agents get an in-process MCP server for renaming their own session, notifying the user ([`claude-sessions.md`](claude-sessions.md#needs-you)), and finding other sessions' messaging addresses; with an LLM proxy, for GPT subagents and image generation; and optionally (off by default) for managing other sessions — see [`settings.md`](settings.md#built-in-tools).

## Voice

Speech input uses the browser's `SpeechRecognition` ([`useVoiceRecording`](../src/hooks/useVoiceRecording.ts)). Read-aloud is Kokoro only, through any OpenAI-compatible `/audio/speech` API that returns PCM (OpenRouter, Kokoro-FastAPI, or optimized-kokoro; opt-in with `TTS_BASE_URL`). There is deliberately no browser-voice fallback: two playback engines weren't worth it for a provider this cheap in an app that needs the network anyway.

- The server ([`speech-store.ts`](../src/server/services/speech-store.ts)) synthesizes raw PCM, the one format every server we use offers, and encodes it as it arrives to AAC in ADTS ([`aac.ts`](../src/server/services/aac.ts)) with a WASM encoder, so there are no native dependencies. ADTS plays while still being written; its cost is that browsers only estimate its duration (Firefox by up to ~15%), which nothing here displays. Because an `<audio>` element can't send the bearer token, the authenticated `POST /api/tts` mints an unguessable `/api/tts/{id}` for it (see [`security.md`](security.md)).
- The client ([`SpeechPlayer`](../src/lib/speech-player.ts)) plays every message through one long-lived `<audio>` element with Media Session metadata, so OS media controls and the lock screen work. Plain `<audio src>` rather than MSE: iOS MSE support is uncertain and a stream needs nothing more.

Voice, speed, and Voice Auto-Send are global server settings. Auto-read is a per-session, per-device preference in `localStorage`.

## Remote File Editing

The "Open in VS Code" button deep-links into a self-hosted [code-server](https://github.com/coder/code-server) on the session's workspace root, so uploads show alongside the clone ([`editor-url.ts`](../src/lib/editor-url.ts)); code-server owns the whole editor experience. Opt-in via `CODE_SERVER_URL`: when it is unset or the workspace is gone, the server returns no URL and the button hides. Setup is [`setup-code-server.sh`](../scripts/setup-code-server.sh) (no sudo) plus [`expose-code-server-tailscale.sh`](../scripts/expose-code-server-tailscale.sh) (tailnet-only, never `funnel`).

## Disk Usage

Settings → Storage lists how much space each workspace would free if archived ([`disk-usage.ts`](../src/server/services/disk-usage.ts)). A hardlinked file counts only if all its links are inside the workspace, because pnpm and uv hardlink their shared caches into checkouts, which made plain `du` overstate some workspaces by 100x. A scan reads every inode under `~/worktrees`, so it runs only when the tab is opened or rescanned, and nothing is stored.

## Where Things Live

- [`src/server/routers/`](../src/server/routers/) — tRPC API. Procedure bases live in [`src/server/trpc.ts`](../src/server/trpc.ts): a procedure that needs the session row builds on `sessionProcedure` (loads `ctx.session` or throws NOT_FOUND) or `runningSessionProcedure` rather than repeating the lookup; ones that only read in-memory state stay on `protectedProcedure`.
- [`src/server/services/`](../src/server/services/) — session/query/workspace management; [`claude-runner.ts`](../src/server/services/claude-runner.ts) orchestrates the session query and its sibling modules own the seams (see [`src/server/services/CLAUDE.md`](../src/server/services/CLAUDE.md))
- [`src/lib/`](../src/lib/) — pure, unit-testable logic shared by server and client
- [`src/hooks/`](../src/hooks/) — React Query + SSE wiring
- [`src/components/`](../src/components/) — UI (see [`src/components/CLAUDE.md`](../src/components/CLAUDE.md))
