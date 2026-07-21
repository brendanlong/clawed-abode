# Clawed Abode - Design Document

## Overview

A self-hosted web application providing mobile-friendly access to Claude Code running on a local machine with GPU support. Sessions are persistent (they survive disconnections and server restarts), isolated by per-session git clones, and reached over Tailscale. The server runs in its own user account on a machine dedicated to this app.

This file is the high-level map and is auto-loaded into every agent session — keep it short. Details live in reference docs, loaded on demand:

- [`claude-sessions.md`](claude-sessions.md) — the persistent SDK query, turn/background status, queued messages, interactive tools, process reaping, cost estimation
- [`messages-and-sse.md`](messages-and-sse.md) — message classification, storage/pagination, SSE streaming/resume
- [`settings.md`](settings.md) — settings layers, model resolution, secrets, MCP servers
- [`security.md`](security.md) — auth and input sanitization
- [`voice.md`](voice.md) — browser speech input/output

Keep this doc, the reference docs, and [`architecture.d2`](architecture.d2) up to date when changing behavior (see the documentation rules in the root `CLAUDE.md`).

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
- **Cursor-based pagination everywhere**, keyed on per-session message `sequence` numbers.

## Data Model

The schema ([`prisma/schema.prisma`](../prisma/schema.prisma)) is the source of truth. Non-obvious semantics:

- `Session.lastActivityAt` is bumped only on **user interactions** (sending a prompt, answering a question/plan) — never on assistant/background traffic or lifecycle changes — so the session list orders by where the user last acted and doesn't shuffle while other sessions generate.
- `Session.claudeModel` is a per-session model override, the highest-precedence layer of model resolution (see [`settings.md`](settings.md)).
- Deleting a session **archives** it: the workspace is removed, messages are kept and viewable read-only, and it's excluded from the session list by default.
- `EnvVar` / `McpServer` rows with `repoSettingsId = null` are global; per-repo entries with the same name take precedence (a partial unique index enforces global name uniqueness). "No Repository" sessions use the `__no_repo__` sentinel in `RepoSettings`.

## Session Lifecycle

- **Create** (`sessions.create`) returns immediately with status `creating`; cloning happens in the background and the UI polls `statusMessage`. An optional initial prompt is sent server-side once the session is running, so it works even if the client disconnects.
- **Interact**: prompts go through the session's persistent streaming query ([`claude-sessions.md`](claude-sessions.md)). The composer is never disabled — a mid-turn send is queued server-side and flushed at turn end.
- **Interrupt** stops only the current turn; the query stays alive. **Stop** closes the query; the worktree stays on disk. **Delete** stops the query, removes the workspace, and archives.
- **Restart recovery**: a server restart loses in-memory state but not intent — a session in DB status `running` is revived lazily with `resume` on the next interaction. In-flight background work is not resurrected (its subprocess is gone); recovery restores the conversation.

### File Uploads

`POST /api/upload` ([`src/app/api/upload/route.ts`](../src/app/api/upload/route.ts)) — a route rather than a tRPC mutation so binary bodies stream as `FormData` instead of being base64-inflated through superjson. Files land in `~/worktrees/{sessionId}/uploads/`, a **sibling of the clone**: readable by the agent, invisible to the checkout's git status, and cleaned up with the workspace on archive (no separate reaper). Stored names get a random prefix (re-uploads never overwrite; no check-then-set) and are sanitized to a safe basename to neutralize path traversal. Size/count caps are enforced up front so a batch never writes partially ([`src/server/services/uploads.ts`](../src/server/services/uploads.ts)). On send, attachment paths are prefixed onto the persisted message text, so the transcript shows exactly what the model saw.

### System Prompt

`DEFAULT_SYSTEM_PROMPT` in [`src/lib/system-prompt.ts`](../src/lib/system-prompt.ts). Rationale for its two main themes:

- Users interact through the web UI with no local file access, so work is only visible once committed, pushed, and PR'd — the prompt requires that workflow.
- All sessions run as one host user alongside the app server, so a bare `pkill`/`killall` by name can kill other sessions or the server; the prompt steers agents to PID-kill or a `--cgroup`-scoped kill.

## Remote File Editing

The "Open in VS Code" button deep-links into a self-hosted [code-server](https://github.com/coder/code-server) on the session's workspace folder (`${CODE_SERVER_URL}/?folder=<workspaceDir>`, built by the pure `buildEditorUrl`, served by `sessions.getEditorUrl`). code-server owns the whole editor experience; the app only contributes the link, which opens the workspace root so uploads are visible alongside the clone. Opt-in: when `CODE_SERVER_URL` is unset (or the session is archived, its workspace gone) the server returns `null` and the button hides — the server is authoritative, the UI stays dumb. Setup is two scripts sharing [`scripts/lib-code-server.sh`](../scripts/lib-code-server.sh): [`setup-code-server.sh`](../scripts/setup-code-server.sh) (no sudo/Tailscale, runnable by the app account; loopback on a random port recorded in code-server's config) and [`expose-code-server-tailscale.sh`](../scripts/expose-code-server-tailscale.sh) (tailnet-only `serve` service — same trust boundary as the app, never `funnel`).

## Where Things Live

- [`src/server/routers/`](../src/server/routers/) — tRPC API (auth, github, sessions, claude, sse, settings)
- [`src/server/services/`](../src/server/services/) — session/query/workspace management; [`claude-runner.ts`](../src/server/services/claude-runner.ts) is the core (see [`src/server/services/CLAUDE.md`](../src/server/services/CLAUDE.md))
- [`src/lib/`](../src/lib/) — pure, unit-testable logic shared by server and client
- [`src/hooks/`](../src/hooks/) — React Query + SSE wiring
- [`src/components/`](../src/components/) — UI (see [`src/components/CLAUDE.md`](../src/components/CLAUDE.md))
