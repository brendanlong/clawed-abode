# Clawed Abode - Design Document

## Overview

A self-hosted web application that provides mobile-friendly access to Claude Code running on local machines with GPU support. The system exposes Claude Code sessions through a web interface, with persistent sessions using separate git clones for isolation.

The system runs **directly on the host** without containers:

- **Separate git clones** provide session isolation — each session gets its own clone at `/worktrees/{sessionId}/`
- **Claude Agent SDK** runs in-process in the Next.js server — no per-session child processes or IPC
- **Native GPU access** — agents use the host's GPU directly
- **Host tools** — agents use whatever development tools are installed on the host

## Goals

- Run Claude Code sessions from mobile devices without a terminal
- Access local GPU resources not available in Claude Code Web
- Persistent sessions that survive disconnections
- Clean session lifecycle tied to git clones
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
                                                │  /worktrees/{sessionId}/          │
                                                │  /data/db/ - SQLite               │
                                                └──────────────────────────────────┘
```

## Data Model

The database schema is defined in [`prisma/schema.prisma`](../prisma/schema.prisma). Key models:

- **Session**: Claude Code sessions tied to git clones or standalone workspaces. `repoUrl` and `branch` are nullable — when null, the session has no repository (workspace-only).
- **Message**: Chat messages with sequence numbers for cursor-based pagination
- **AuthSession**: Login sessions with tokens and audit info
- **GlobalSettings**: Global application settings (system prompt override and append, Claude model, Claude API key, TTS speed, voice auto-send)
- **RepoSettings**: Per-repository settings (favorites, custom system prompt, Claude model override)
- **EnvVar**: Environment variables for a repository or global (encrypted if secret). When `repoSettingsId` is null, the variable is global and applies to all sessions.
- **McpServer**: MCP server configurations for a repository or global. When `repoSettingsId` is null, the server is global and applies to all sessions.

### Session Archiving

When a session is deleted, it is archived rather than permanently removed. This preserves the message history for later viewing. Archived sessions:

- Have status set to `archived` and archivedAt timestamp recorded
- Have their workspace directory removed
- Keep all messages in the database for viewing
- Are excluded from the session list by default (toggle available to show them)
- Are read-only: no start/stop controls, no prompt input

### Data Storage

The system uses **host filesystem directories**:

1. **Database** (`/data/db/`): SQLite database.

2. **Session Workspaces** (`/worktrees/{sessionId}/{repoName}`): Each session gets its own git clone. Provides filesystem isolation between sessions.

### Workspace Structure

Each session's clone is at `/worktrees/{sessionId}/{repo-name}`. For no-repo sessions, just `/worktrees/{sessionId}/`.

The clone is the agent's working directory. Each session is fully isolated.

## API Design (tRPC)

### Authentication

Single-user authentication using password stored in `PASSWORD_HASH` environment variable (base64-encoded Argon2 hash).

```typescript
auth.login({ password })
  → { token }

auth.logout()
  → { success: true }

auth.logoutAll()
  → { success: true }
  // Deletes all sessions

auth.listSessions()
  → { sessions: AuthSession[] }
  // View all login sessions with IP/user agent

auth.deleteSession({ sessionId })
  → { success: true }
  // Revoke a specific session
```

### GitHub Integration

```typescript
github.listRepos({ search?: string, cursor?: string })
  → { repos: Repo[], nextCursor?: string }

github.listBranches({ repoFullName: string })
  → { branches: Branch[], defaultBranch: string }

github.listIssues({
  repoFullName: string,
  search?: string,
  state?: 'open' | 'closed' | 'all',  // default: 'open'
  cursor?: string,
  perPage?: number
})
  → { issues: Issue[], nextCursor?: string }
  // Lists issues for a repository with optional search and pagination

github.getIssue({ repoFullName: string, issueNumber: number })
  → { issue: Issue }
  // Get full details of a specific issue
```

### Session Management

```typescript
sessions.create({
  name: string,
  repoFullName?: string,   // e.g., "brendanlong/math-llm" — omit for no-repo sessions
  branch?: string,         // omit for no-repo sessions
  initialPrompt?: string   // Optional prompt to auto-send when session starts
})
  → { session: Session }
  // Returns immediately with session in "creating" status
  // Cloning continues in background (skipped for no-repo sessions)
  // UI polls session.get() to track progress via statusMessage
  // If initialPrompt is provided, it is sent automatically server-side when session becomes running

sessions.list({ status?: SessionStatus })
  → { sessions: Session[] }

sessions.get({ sessionId: string })
  → { session: Session }

sessions.start({ sessionId: string })
  → { session: Session }
  // Marks session as running (workspace already exists on disk)

sessions.stop({ sessionId: string })
  → { session: Session }
  // Stops any running Claude query, marks session as stopped

sessions.delete({ sessionId: string })
  → { success: true }
  // Stops query, removes workspace, archives session
```

### Claude Interaction

```typescript
claude.send({ sessionId: string, prompt: string })
  → { success: true }
  // Starts a query() call in-process using the Claude Agent SDK
  // Messages stream to the client via SSE

claude.answerQuestion({
  sessionId: string,
  toolUseId: string,                    // the AskUserQuestion tool_use block id
  answers: Record<string, string>
})
  → { success: true, routed: 'live' | 'fallback' | 'already' }
  // Delivers answers to an AskUserQuestion tool call. The server decides how
  // (see "Answering Interactive Tools" below): resolve the live canUseTool
  // promise, or — if the query has ended — resume with a new turn.

claude.respondToPlan({
  sessionId: string,
  toolUseId: string,                    // the ExitPlanMode tool_use block id
  approve: boolean,
  feedback?: string                     // revision notes (used when approve=false)
})
  → { success: true, routed: 'live' | 'fallback' | 'already' }
  // Approve or request changes to an ExitPlanMode plan, routed the same way
  // as answerQuestion.

claude.interrupt({ sessionId: string })
  → { success: true }
  // Sends SIGINT to running claude process

claude.getHistory({
  sessionId: string,
  cursor?: number,        // sequence number
  direction: 'before' | 'after',
  limit?: number          // default 50
})
  → { messages: Message[], nextCursor?: number, hasMore: boolean }
```

## Session Lifecycle

### Creation Flow

1. User selects repo and branch from UI (or "No Repository" for workspace-only sessions)
2. Server calls `sessions.create()`
3. Server creates session record with status `creating` and returns immediately
4. UI navigates to session page, polls for status updates
5. **For repo sessions**: Background: Server clones the repository to `/worktrees/{sessionId}/{repoName}`
   **For no-repo sessions**: Background: Server creates an empty directory at `/worktrees/{sessionId}/`
6. Session status → `running`, statusMessage → null
7. Background: If an initial prompt was provided, server sends it via `runClaudeCommand()` (no client interaction needed)

### Interaction Flow

1. User sends prompt via `claude.send()`
2. Next.js server calls `query()` from the Claude Agent SDK directly in-process, with `resume: sessionId` for follow-up messages
3. The `canUseTool` callback handles:
   - **AskUserQuestion** / **ExitPlanMode**: Parks a promise keyed by the SDK's `toolUseID`, sends the question/plan to the browser via SSE (as a normal assistant message with a `tool_use` block). The user responds via `claude.answerQuestion()` / `claude.respondToPlan()` (see [Answering Interactive Tools](#answering-interactive-tools)).
   - **All other tools**: Auto-approved (bypass permissions mode).
4. Messages stream from the SDK:
   - **Partial messages**: `stream_event` messages are accumulated by `StreamAccumulator` and emitted via SSE for real-time UI updates (not persisted).
   - **Complete messages**: Saved to database with incrementing sequence numbers, emitted via SSE.
5. Browser client receives SSE events and updates the message cache.
6. On completion, `result` message marks end of turn.

### System Prompt

A system prompt is appended to all Claude sessions to ensure proper workflow. Since users interact through the web interface and have no local access to files, Claude must always commit, push, and open PRs for changes to be visible.

The system prompt instructs Claude to:

1. Always commit changes with clear, descriptive commit messages
2. Always push commits to the remote repository
3. Open a Pull Request (using `gh pr create`) for new branches or changes that benefit from review
4. If a PR already exists, just push to update it

This ensures users can see all changes through GitHub, which is their only way to access the codebase.

### Interruption Flow

1. User clicks "Stop" in UI
2. Server calls `claude.interrupt()`
3. Server calls `interrupt()` on the in-process SDK query
4. Any pending `canUseTool` promise is rejected
5. Claude Code cleans up
6. User can send new prompt to continue (with resume)

### Reconnection Flow

1. Client reconnects after disconnect
2. Client calls `claude.getHistory({ sessionId, cursor: lastSeenSequence, direction: 'after' })`
3. Server returns all messages after that sequence
4. Client merges into local state
5. If a `claude` process is still running, client re-subscribes to stream

### Deletion Flow

1. User deletes session
2. Server stops any running Claude query
3. Server removes workspace directory
4. Session is archived (messages preserved for viewing)

## Claude Agent SDK Integration

The Next.js server uses the `@anthropic-ai/claude-agent-sdk` directly in-process to interact with Claude. No per-session processes, containers, or IPC.

### Query Model

Each user prompt is a separate `query()` call with `resume: sessionId` for multi-turn conversations. This approach:

- Requires no persistent processes between prompts
- Handles server restarts gracefully (just resume with the session ID)
- Simplifies the architecture significantly

### User Input (canUseTool)

The SDK's `canUseTool` callback handles interactive tools:

- **AskUserQuestion** / **ExitPlanMode**: The callback parks a `Promise` (keyed by the SDK's `toolUseID`) in the in-memory session state. It is resolved when the user responds — see [Answering Interactive Tools](#answering-interactive-tools). The request appears as a normal assistant message (`tool_use` block) in the UI.
- **All other tools**: Auto-approved (`bypassPermissions` mode).

### Answering Interactive Tools

The hard part is that the parked `Promise` lives only in the in-memory session map. It is destroyed when the query ends — completion, stop, interrupt, or a **server restart** — but the `tool_use` block survives in the database forever. If the UI decided interactivity from its own state, the two could disagree (controls shown for a question that can no longer be answered), or a transient running-state signal could wrongly disable the controls. To avoid this, **the server is authoritative** and the UI stays dumb:

- **UI rule**: answer controls are shown whenever a `tool_use` block has no matching `tool_result` (purely DB-derived in `MessageList`/`AskUserQuestionDisplay`/`ExitPlanModeDisplay`). The UI never consults running-state to decide interactivity. On submit it calls `claude.answerQuestion` / `claude.respondToPlan` with the block's `toolUseId`.
- **Server routing** (`submitToolResponse` in [`src/server/routers/claude.ts`](../src/server/routers/claude.ts)):
  1. **Live** — if a query is still parked on that `toolUseId`, resolve the in-memory promise so the current turn continues (cheap, no new query). A short wait covers the rare race where the answer beats the SDK's `canUseTool` call.
  2. **Fallback** — if no live promise exists (the query ended), the original tool call can never be resolved, so the answer is delivered as a **new turn**: the server persists a synthetic `tool_result` for the block (pairing it in the UI so the controls disappear) and resumes the session with a prompt built from the answer. This is the automatic "fall back to the normal chat interface" path.
- **Idempotency**: the synthetic `tool_result`'s message id is derived from the `toolUseId`, so a duplicate submit hits the unique constraint and is a no-op (`routed: 'already'`) — a double answer never starts two turns.
- **Mapping responses**: an `AskUserQuestion` answer resolves `allow` with the selected answers; an `ExitPlanMode` approval resolves `allow`, while "request changes" resolves `deny` with the feedback message so Claude revises in place. On the fallback path these become natural-language prompts (see `formatToolResponsePrompt` in [`src/lib/tool-response.ts`](../src/lib/tool-response.ts)).

### Streaming

The SDK emits `stream_event` messages which are accumulated by `StreamAccumulator` into partial assistant messages for real-time UI updates. These are emitted to the browser via SSE but not persisted.

**Implementation:** [`src/server/services/claude-runner.ts`](../src/server/services/claude-runner.ts)

### Thinking Blocks

When extended thinking is active, assistant messages include `thinking` (and, when the API encrypts reasoning, `redacted_thinking`) content blocks alongside `text` and `tool_use`. These are accumulated during streaming (`thinking_delta` events) and rendered as a single collapsed "Thinking" section per message (`ThinkingDisplay`), coalescing multiple thinking blocks into one. Thinking text is excluded from copy/voice output.

During redacted thinking the SDK also emits frequent `{ type: 'system', subtype: 'thinking_tokens' }` progress messages carrying only live token-count estimates. These are dropped (not persisted or shown) via `isIgnoredSystemMessage` in [`src/lib/claude-messages.ts`](../src/lib/claude-messages.ts) — one of several ignored system subtypes (see [System Message Subtypes](#system-message-subtypes)) — so they don't render as a stream of empty "System" bubbles.

### Message Classification

Every message yielded by the SDK is routed through `classifyMessage(message)` in [`src/lib/claude-messages.ts`](../src/lib/claude-messages.ts), which returns one of `{ kind: 'stream_event' | 'skip' | 'persist' }` (with the DB column type for `persist`). It `switch`es over the SDK's `SDKMessage` discriminated union and ends in `assertNeverFallback`, a compile-time exhaustiveness guard: if a future SDK release adds a top-level message `type`, the build fails until it is handled here. At runtime an unrecognized type degrades to generic system persistence rather than throwing, so an unexpected frame never crashes the query loop.

### System Message Subtypes

The SDK emits many `type: 'system'` subtypes. A single `type`-level switch can't distinguish them, so subtype handling is split into three buckets (none of which is compile-time exhaustive — unknown subtypes fall through to a safe default):

1. **Ignored** (`IGNORED_SYSTEM_SUBTYPES` + any message flagged `skip_transcript`): pure progress ticks and internal state — `thinking_tokens`, `task_progress`, `task_updated`, `hook_progress`, `status`, `session_state_changed`, `files_persisted`, `elicitation_complete`, `commands_changed`. `classifyMessage` returns `skip`, so they are never persisted; `isIgnoredSystemMessage` also filters any persisted before a subtype was added (both at the list level in `MessageList` so they leave no empty spacer row, and as a guard in `MessageBubble`).
2. **Dedicated displays**: `init`, `compact_boundary`, `hook_started`, `hook_response`, and the app's synthetic `error` each have their own component.
3. **Generic summary**: everything else (e.g. `notification`, `api_retry`, `permission_denied`, `model_refusal_fallback`, `plugin_install`, `memory_recall`, `mirror_error`, `task_started`, `task_notification`) renders through `SystemMessageDisplay`, which calls `summarizeSystemMessage` to produce a never-blank `{ label, body, level }`. Unknown/future subtypes degrade to a humanized label plus any string `content`, so a system message is never an empty bubble. `level: 'warn'` (retries, denials, errors) gets an amber treatment.

Subagent (`Task` tool) lifecycle: `task_started` and `task_notification` are the meaningful bookends and are summarized; the high-frequency `task_progress` ticks and intermediate `task_updated` patches are ignored (their terminal outcome arrives via `task_notification`).

## Message Storage & Pagination

Messages are stored with a monotonically increasing sequence number per session (see `Message` model in [`prisma/schema.prisma`](../prisma/schema.prisma)). This enables efficient cursor-based pagination.

### Pagination Queries

**Load recent (initial view):**

```sql
SELECT * FROM messages
WHERE session_id = ?
ORDER BY sequence DESC
LIMIT 50;
```

**Load older (scroll up):**

```sql
SELECT * FROM messages
WHERE session_id = ? AND sequence < ?
ORDER BY sequence DESC
LIMIT 50;
```

**Poll for new (after reconnect):**

```sql
SELECT * FROM messages
WHERE session_id = ? AND sequence > ?
ORDER BY sequence ASC;
```

## Security

### Authentication Layers

1. **Tailscale Serve/Funnel** — Traffic encrypted over HTTPS, no exposed ports
2. **Password Authentication** — Single-user auth with:
   - Password stored as base64-encoded Argon2 hash in `PASSWORD_HASH` env var
   - Database-backed sessions with 256-bit random tokens
   - 7-day session expiration
   - Session tracking (IP address, user agent) for audit

### Session Isolation

- Each session runs in its own git clone at `/worktrees/{sessionId}/`
- Agents share the host filesystem, user, and installed tools
- `bypassPermissions` mode is used since the machine is dedicated to running this app
- The machine should be dedicated to this application — not shared with other users

### GitHub Token Security

- Use a **fine-grained Personal Access Token** for minimum required permissions
- Scope the token to only the repositories you want to use
- Grant only "Contents: Read and write" permission (for push/pull)
- Create at: https://github.com/settings/personal-access-tokens/new
- The token is configured via a git credential helper in each clone

### Per-Repository Settings & Secrets

Users can configure per-repository settings that are automatically applied when creating sessions. This also applies to "No Repository" sessions, which use the sentinel value `__no_repo__` as their `repoFullName` in `RepoSettings`.

- **Favorites**: Mark repositories (or "No Repository") as favorites so they appear at the top of the repo selector
- **Custom System Prompt**: Additional instructions appended to the default system prompt for all sessions using this repository
- **Claude Model**: Override the model for all sessions using this repository. Takes precedence over the global model and the `CLAUDE_MODEL` env var. Falls back to those when not set.
- **Environment Variables**: Custom env vars set for Claude sessions (e.g., API keys, config values)
- **MCP Servers**: Configure [MCP servers](https://modelcontextprotocol.io/) for Claude to use, supporting three transport types:
  - **Stdio**: Traditional command-based servers (e.g., `npx @anthropic/mcp-server-memory`)
  - **HTTP**: Streamable HTTP MCP servers with optional auth headers
  - **SSE**: Server-Sent Events MCP servers with optional auth headers

**Secret Encryption**: Environment variables, MCP server env vars, and HTTP/SSE header values can be marked as "secret", which:

- Encrypts the value at rest using AES-256-GCM with the `ENCRYPTION_KEY` env var
- Displays masked values (`••••••••`) in the UI
- Decrypts values only when starting a Claude query (passed as environment or SDK options)

**Configuration**:

1. Set `ENCRYPTION_KEY` to a 32+ character random string (generate with: `openssl rand -base64 32`)
2. Go to Settings → Repositories to manage per-repo settings
3. Or use the star icon in the new session repo selector to toggle favorites

**Implementation**: See [`src/server/routers/repoSettings.ts`](../src/server/routers/repoSettings.ts) for the API and [`src/lib/crypto.ts`](../src/lib/crypto.ts) for encryption.

### Global Settings

Users can configure global settings that apply to all sessions:

- **Claude Model**: Override the `CLAUDE_MODEL` environment variable. Free-text field accepting model names like `opus`, `sonnet`, or full IDs like `claude-opus-4-6`. A per-repo model override (if set) takes precedence over this; otherwise this is used, falling back to the env var default when neither is set. Resolution order is `repo model → global model → CLAUDE_MODEL env var` (see `resolveClaudeModel` in `settings-merger.ts`).
- **Claude API Key**: Override the `CLAUDE_CODE_OAUTH_TOKEN` environment variable. Stored encrypted at rest. The actual value is never exposed to the UI — only a "configured" status is shown. Falls back to the env var when not set.
- **System Prompt Override**: Replace the default system prompt with a custom one. When editing, the field is pre-populated with the current default prompt. The override can be toggled on/off without losing the custom content.
- **Global System Prompt Append**: Additional content appended to the base prompt (default or override) for all sessions. This is applied before any per-repo custom prompts.
- **Global Environment Variables**: Environment variables applied to all sessions. Per-repo variables with the same name take precedence.
- **Global MCP Servers**: MCP server configurations available in all sessions. Per-repo servers with the same name take precedence. Supports stdio, HTTP, and SSE transport types.
- **TTS Speed**: Controls text-to-speech playback speed (0.25x to 4.0x, default 1.0x). Passed to `SpeechSynthesis.rate` via the browser's Web Speech API. Configured in Settings → Audio.
- **Voice Auto-Send**: When enabled (default: true), speech-to-text transcripts are automatically sent as prompts after recording stops. When disabled, transcripts are inserted into the input field for editing. Configured in Settings → Audio.

**Prompt Order**: When Claude runs, the system prompt is built in this order:

1. Base prompt (either the default or the override if enabled)
2. Global append content (if set)
3. Per-repository custom prompt (if set for that repo)

**Settings Merging**: When a session starts, global and per-repo settings are merged:

- **Environment Variables**: Global env vars are included in all sessions. If a per-repo env var has the same name as a global one, the per-repo value takes precedence.
- **MCP Servers**: Global MCP servers are included in all sessions. If a per-repo MCP server has the same name as a global one, the per-repo configuration takes precedence.
- **Claude Model**: Resolved in precedence order `per-repo model → global model → CLAUDE_MODEL env var`.

**Configuration**: Go to Settings → System Prompt to manage prompt and model settings. Go to Settings → Audio to manage voice/audio settings (TTS speed, voice auto-send).

**Data Model**: Global env vars and MCP servers are stored in the same `EnvVar` and `McpServer` tables as per-repo ones, with `repoSettingsId = null` indicating a global setting. A partial unique index (`WHERE repoSettingsId IS NULL`) enforces name uniqueness for global entries at the database level.

**Implementation**: See [`src/server/routers/globalSettings.ts`](../src/server/routers/globalSettings.ts) for the API, [`src/server/services/global-settings.ts`](../src/server/services/global-settings.ts) for the service layer, [`src/server/services/settings-merger.ts`](../src/server/services/settings-merger.ts) for the merging logic, and [`src/server/services/settings-helpers.ts`](../src/server/services/settings-helpers.ts) for shared validation schemas, encryption helpers, and decrypt functions used by both global and per-repo settings.

### Voice Mode

Voice mode provides speech-to-text input and text-to-speech output for hands-free interaction with Claude sessions using browser-native Web Speech APIs. No API keys or server-side processing required.

**Requirements**: A browser that supports the Web Speech API. `SpeechRecognition` provides STT (Chrome, Edge, Safari; not Firefox without a flag). `SpeechSynthesis` provides TTS (all major browsers).

**Architecture**:

- **Voice input (STT)**: Browser `SpeechRecognition` API provides real-time transcription directly in the browser. No server round-trip needed. Supports interim results for real-time feedback during recording.
- **Voice output (TTS)**: Browser `SpeechSynthesis` API speaks text locally. Long text is chunked at sentence boundaries to work around Chrome's ~15-second utterance bug ([Chromium bug](https://issues.chromium.org/issues/41294170)). `SpeechSynthesisUtterance.rate` is set from the TTS Speed setting.

**Known Limitations**:

- TTS quality is lower than cloud-based solutions (varies by OS/browser)
- Chrome: utterances over ~15s stop abruptly (worked around by chunking)
- Android: `speechSynthesis.pause()` acts as `cancel()` — pause/resume doesn't work
- Background tabs: `SpeechSynthesis` may be silenced/cancelled when tab is backgrounded
- STT: `SpeechRecognition` not available in Firefox (without a flag)
- iOS: requires user activation for `speak()` calls

**Components**:

- `VoiceControlPanel`: Inline voice controls panel that replaces PromptInput when voice mode is active. Provides playback navigation (prev/next/play/pause/stop), a large mic button for recording, send/cancel for transcripts, and an exit button. Renders as a normal flow element at the bottom of the session view (not a modal).
- `VoiceMicButton`: Push-to-talk button in PromptInput. Click to start recording, click again to stop. Shows interim transcript during recording.
- `MessagePlayButton`: Per-message play/pause button on assistant messages. Visible when voice is enabled.
- `VoiceAutoReadToggle`: Toggle in SessionHeader. When enabled, automatically speaks the last assistant message when Claude finishes a turn.

**Hooks**:

- `useVoiceConfig`: Detects browser Web Speech API support and manages auto-read preference per session (localStorage). Queries server for `ttsSpeed` and `voiceAutoSend` settings.
- `useVoiceRecording`: Wraps the browser `SpeechRecognition` API. Provides real-time interim transcripts and final results.
- `useVoicePlayback`: Central playback state via React Context. Uses `SpeechSynthesis` for TTS with text chunking for Chrome compatibility. Supports sequential playback queue for auto-read.

**Implementation**: See [`src/hooks/useVoiceRecording.ts`](../src/hooks/useVoiceRecording.ts), [`src/hooks/useVoicePlayback.ts`](../src/hooks/useVoicePlayback.ts), [`src/hooks/useVoiceConfig.ts`](../src/hooks/useVoiceConfig.ts), and [`src/components/voice/`](../src/components/voice/) for UI components.

## UI Screens

### Session List (Home)

- List of sessions with name, repo, status, last activity
- "New Session" button
- Quick actions: resume, stop, delete

### New Session

- Search/select GitHub repo **or** "No Repository (workspace only)" for repo-free sessions
  - "No Repository" is shown in the repo selector, favoritable, and configurable via RepoSettings (uses `__no_repo__` sentinel)
  - When "No Repository" is selected, branch and issue selectors are hidden
- Select branch (defaults to default branch) — only shown for repo sessions
- Optional: Select a GitHub issue to work on — only shown for repo sessions
  - Searchable dropdown with open issues
  - When selected, auto-fills session name with issue title
  - Pre-fills initial prompt asking Claude to fix the issue (editable)
- Name the session (optional, auto-filled from issue if selected, defaults to "Workspace" for no-repo)
- Initial prompt (optional) — editable textarea, pre-filled when issue is selected
  - If provided, sent server-side after session setup completes (works even if client disconnects)
  - When omitted, session starts without a prompt (useful for voice mode)
- Create button

### Session View (Chat)

- Message history with lazy loading on scroll up
- Input field for new prompts
- Stop button (visible during Claude execution)
- Tool calls rendered with expandable input/output
- Status indicator (running, waiting, stopped)
- Session info in header (repo, branch)

## File Structure

```
clawed-abode/
├── shared/
│   └── agent-types.ts          # Shared types (PartialAssistantMessage)
├── scripts/
│   ├── hash-password.ts        # Password hashing utility
│   └── update.sh               # Production update: pull, install, migrate, build, restart
├── src/
│   ├── server/
│   │   ├── routers/
│   │   │   ├── index.ts           # Router exports
│   │   │   ├── auth.ts
│   │   │   ├── github.ts
│   │   │   ├── sessions.ts
│   │   │   ├── claude.ts
│   │   │   ├── sse.ts             # SSE event streaming
│   │   │   ├── repoSettings.ts
│   │   │   └── globalSettings.ts
│   │   ├── services/
│   │   │   ├── worktree-manager.ts # Git clone lifecycle
│   │   │   ├── claude-runner.ts   # In-process Claude Agent SDK queries
│   │   │   ├── stream-accumulator.ts # Accumulates stream_events into partials
│   │   │   ├── global-settings.ts # Global settings service
│   │   │   ├── repo-settings.ts   # Per-repo settings service
│   │   │   ├── settings-helpers.ts # Shared schemas, encryption, decrypt helpers
│   │   │   ├── settings-merger.ts # Merges global + per-repo env vars and MCP servers
│   │   │   ├── events.ts         # SSE event emitter
│   │   │   ├── anthropic-models.ts # Claude model configuration
│   │   │   ├── github.ts         # GitHub API service
│   │   │   ├── mcp-validator.ts  # MCP server config validation
│   │   │   └── session-reconciler.ts # Marks sessions stopped on restart
│   │   └── trpc.ts
│   ├── lib/
│   │   ├── auth.ts               # Authentication utilities
│   │   ├── crypto.ts             # Encryption/decryption (AES-256-GCM)
│   │   ├── logger.ts             # Centralized logging (createLogger)
│   │   ├── prisma.ts             # Prisma client initialization
│   │   ├── trpc.ts               # tRPC client setup
│   │   └── types.ts              # Global TypeScript types
│   ├── hooks/                    # React hooks (session state, messages, etc.)
│   ├── app/
│   │   ├── page.tsx              # Session list
│   │   ├── new/page.tsx          # New session
│   │   ├── session/[id]/page.tsx # Session view
│   │   ├── settings/page.tsx     # Settings
│   │   └── login/page.tsx
│   └── components/
│       ├── MessageList.tsx
│       ├── PromptInput.tsx
│       ├── SessionList.tsx
│       ├── Header.tsx
│       ├── messages/             # Tool-specific display components (Bash, Edit, Read, etc.)
│       ├── settings/             # Settings UI (global settings, repo settings, audio, env vars, MCP)
│       ├── ui/                   # shadcn/ui primitives (button, dialog, input, etc.)
│       └── voice/               # Voice UI components
│           ├── VoiceControlPanel.tsx
│           ├── VoiceMicButton.tsx
│           ├── MessagePlayButton.tsx
│           └── VoiceAutoReadToggle.tsx
├── prisma/
│   └── schema.prisma
└── package.json
```

## Testing

### Test Categories

- **Unit tests** (`*.test.ts`): Pure functions and isolated logic. Run with `pnpm test:unit`.
- **Integration tests** (`*.integration.test.ts`): Tests using real external systems (git, SQLite). Run with `pnpm test:integration`.

### Test File Locations

Tests are co-located with source files:

- `src/lib/auth.ts` → `src/lib/auth.test.ts`
- `src/server/services/git.ts` → `src/server/services/git.integration.test.ts`

### Running Tests

```bash
pnpm test          # Watch mode
pnpm test:run      # Single run
pnpm test:unit     # Unit tests only
pnpm test:integration  # Integration tests only
pnpm test:coverage # With coverage report
```
