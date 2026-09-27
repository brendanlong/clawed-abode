# Clawed Abode - Design Document

## Overview

A self-hosted web application providing mobile-friendly access to Claude Code running on a local machine with GPU support. Sessions are persistent (they survive disconnections and server restarts), isolated by per-session git clones, and reached over Tailscale. The server runs in its own user account on a machine dedicated to this app.

This file is the high-level map. Details live in reference docs, loaded on demand:

- [`claude-sessions.md`](claude-sessions.md) — the persistent SDK query, turn/background status, message delivery, interactive tools, process reaping, cost estimation
- [`messages-and-sse.md`](messages-and-sse.md) — message classification, storage/pagination, SSE streaming/resume
- [`settings.md`](settings.md) — settings layers, model resolution, secrets, MCP servers
- [`rate-limit-pause.md`](rate-limit-pause.md) — pausing sessions on subscription usage limits and draining when the window resets
- [`security.md`](security.md) — auth and input sanitization

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

- **No containers.** The Claude Agent SDK runs in-process in the Next.js server; agents use the host's tools and GPU directly. Each session's `claude` CLI subprocess runs in its own systemd user scope so everything it spawned can be reaped at session end (see [`claude-sessions.md`](claude-sessions.md)).
- **Isolation is convention-only.** Each session gets its own clone at `~/worktrees/{sessionId}/{repoName}` (no-repo sessions get a bare `~/worktrees/{sessionId}/`), but all sessions share the host user, filesystem, and installed tools, and can see each other's worktrees. `bypassPermissions` mode is used; the machine must be dedicated to this app.
- **SQLite + Prisma 7** with the Rust-free `prisma-client` generator (client generated to `src/generated/prisma/`, gitignored; imported via `@/generated/prisma/client`). Schema: [`prisma/schema.prisma`](../prisma/schema.prisma); CLI config: [`prisma.config.ts`](../prisma.config.ts).
- **tRPC for the API** ([`src/server/routers/`](../src/server/routers/)); **SSE for all server→client streaming**. Client→server actions are ordinary mutations, so a bidirectional transport (WebSockets) is unnecessary.
- **Single-user password auth** behind Tailscale — see [`security.md`](security.md).
- **Cursor-based pagination everywhere**: messages by per-session `sequence`; session and auth-session lists by a `(timestamp desc, id desc)` keyset ([`src/lib/keyset-page.ts`](../src/lib/keyset-page.ts)).
- **Environment is validated once at boot** ([`src/lib/env.ts`](../src/lib/env.ts), called from instrumentation) so a bad variable stops startup instead of the first request that reads it.

## Data Model

The schema ([`prisma/schema.prisma`](../prisma/schema.prisma)) is the source of truth. Non-obvious semantics:

- `Session.lastActivityAt` is bumped only on **user interactions** (sending a prompt, answering a question/plan) — never on assistant/background traffic or lifecycle changes — so the session list orders by where the user last acted and doesn't shuffle while other sessions generate.
- `Session.pullRequest` is a JSON snapshot of the PR for `currentBranch`, refreshed after each turn and after git/PR tool calls, and re-polled when `prCheckedAt` ages out, so listing sessions never waits on GitHub (see [`messages-and-sse.md`](messages-and-sse.md)).
- Deleting a session **archives** it: the workspace is removed, messages are kept and viewable read-only, and it's excluded from the session list by default.
- "No Repository" sessions use the `__no_repo__` sentinel in `RepoSettings`.

## Session Lifecycle

- **Create** (`sessions.create`) returns immediately with status `creating`; cloning happens in the background, with progress in `statusMessage` pushed over SSE. An optional initial prompt is sent server-side once the session is running, so it works even if the client disconnects.
- **Interact**: prompts go through the session's persistent streaming query ([`claude-sessions.md`](claude-sessions.md)); a mid-turn send goes straight to the agent.
- **Interrupt** stops only the current turn; the query stays alive. **Stop** closes the query; the worktree stays on disk and **Start** revives it. **Delete** stops the query, removes the workspace, and archives.
- **Restart recovery**: a server restart loses in-memory state but not intent — a session in DB status `running` is revived lazily with `resume` on the next interaction. In-flight background work is not resurrected (its subprocess is gone); recovery restores the conversation.

### File Uploads

`POST /api/upload` ([`src/app/api/upload/route.ts`](../src/app/api/upload/route.ts)) — a route rather than a tRPC mutation so binary bodies stream as `FormData` instead of being base64-inflated through superjson. Files land in an `uploads/` **sibling of the clone**, so they are readable by the agent but invisible to git status and removed with the workspace on archive. Stored names get a random prefix (re-uploads never overwrite; no check-then-set) and a sanitized basename, and size/count caps are enforced up front so a batch never writes partially ([`src/server/services/uploads.ts`](../src/server/services/uploads.ts)). On send, attachment paths are prefixed onto the persisted message text, so the transcript shows exactly what the model saw.

### Public Files

Opt-in (`PUBLIC_FILES_PORT` + `PUBLIC_FILES_URL`): a second HTTP server in the same process ([`public-files-server.ts`](../src/server/services/public-files-server.ts)) serves each workspace's `public/` directory (a sibling of the clone, like `uploads/`) at `/{sessionId}/…`, and the system prompt gives each session its directory and URL — so agents hand the user a stable link instead of running their own HTTP server. It is a separate port rather than an app route to give agent-written pages their own origin (see [`security.md`](security.md)). Exposed by [`scripts/expose-public-files-tailscale.sh`](../scripts/expose-public-files-tailscale.sh).

### System Prompt

`DEFAULT_SYSTEM_PROMPT` in [`src/lib/system-prompt.ts`](../src/lib/system-prompt.ts) — the prompt text states its own rationale: the user has no local file access (so commit/push/PR is mandatory), and every session shares one host user with the app server (so kill by PID or a `--cgroup`-scoped pattern, never by name).

## Voice

Speech input uses the browser's `SpeechRecognition` ([`useVoiceRecording`](../src/hooks/useVoiceRecording.ts)). Read-aloud is Kokoro only, through any OpenAI-compatible `/audio/speech` API (OpenRouter or a local Kokoro-FastAPI; opt-in with `TTS_BASE_URL`). There is deliberately no browser-voice fallback: two playback engines weren't worth it for a provider this cheap in an app that needs the network anyway.

- The server ([`speech-store.ts`](../src/server/services/speech-store.ts)) synthesizes a message in chunks and streams them as one MP3, cached in memory so replays are free. Because an `<audio>` element can't send the bearer token, the authenticated `POST /api/tts` mints an unguessable `/api/tts/{id}` for it (see [`security.md`](security.md)).
- The client ([`SpeechPlayer`](../src/lib/speech-player.ts), wired by [`useVoicePlayback`](../src/hooks/useVoicePlayback.ts)) plays every message through one long-lived `<audio>` element with Media Session metadata, so OS media controls and the lock screen work. Plain `<audio src>` rather than MSE: iOS MSE support for MP3 is uncertain and a stream needs nothing more.

Voice, speed, and Voice Auto-Send are global server settings. Auto-read is a per-session, per-device preference in `localStorage`.

## Remote File Editing

The "Open in VS Code" button deep-links into a self-hosted [code-server](https://github.com/coder/code-server) on the session's workspace folder (`${CODE_SERVER_URL}/?folder=<workspaceDir>`, built by the pure `buildEditorUrl`, served by `sessions.getEditorUrl`). code-server owns the whole editor experience; the app only contributes the link, which opens the workspace root so uploads are visible alongside the clone. Opt-in: when `CODE_SERVER_URL` is unset (or the session is archived, its workspace gone) the server returns `null` and the button hides — the server is authoritative, the UI stays dumb. Setup is two scripts sharing [`scripts/lib-code-server.sh`](../scripts/lib-code-server.sh): [`setup-code-server.sh`](../scripts/setup-code-server.sh) (no sudo, runnable by the app account) and [`expose-code-server-tailscale.sh`](../scripts/expose-code-server-tailscale.sh) (tailnet-only, never `funnel`).

## Where Things Live

- [`src/server/routers/`](../src/server/routers/) — tRPC API. Procedure bases live in [`src/server/trpc.ts`](../src/server/trpc.ts): a procedure that needs the session row builds on `sessionProcedure` (loads `ctx.session` or throws NOT_FOUND) or `runningSessionProcedure` rather than repeating the lookup; ones that only read in-memory state stay on `protectedProcedure`.
- [`src/server/services/`](../src/server/services/) — session/query/workspace management; [`claude-runner.ts`](../src/server/services/claude-runner.ts) orchestrates the session query and its sibling modules own the seams (see [`src/server/services/CLAUDE.md`](../src/server/services/CLAUDE.md))
- [`src/lib/`](../src/lib/) — pure, unit-testable logic shared by server and client
- [`src/hooks/`](../src/hooks/) — React Query + SSE wiring
- [`src/components/`](../src/components/) — UI (see [`src/components/CLAUDE.md`](../src/components/CLAUDE.md))
