/**
 * Orchestrates Claude SDK queries directly in-process.
 *
 * Replaces the previous architecture where each session ran an agent-service
 * process inside a container, communicated via Unix sockets. Now the SDK's
 * query() function runs directly in the Next.js server process.
 *
 * Each session uses separate query() calls with resume for multi-turn
 * conversations. The canUseTool callback handles AskUserQuestion by
 * parking a promise that resolves when the user answers via tRPC.
 */

import { query, type McpServerConfig } from '@anthropic-ai/claude-agent-sdk';
import { prisma } from '@/lib/prisma';
import { getMessageType } from '@/lib/claude-messages';
import { extractRepoFullName } from '@/lib/utils';
import { v4 as uuid, v5 as uuidv5 } from 'uuid';
import { sseEvents } from './events';
import { createLogger, toError } from '@/lib/logger';
import { fetchPullRequestForBranch } from './github';
import { getCurrentBranch } from './worktree-manager';
import { StreamAccumulator } from './stream-accumulator';

const log = createLogger('claude-runner');

// Namespace UUID for generating deterministic IDs from error content
const ERROR_LINE_NAMESPACE = '6ba7b810-9dad-11d1-80b4-00c04fd430c8';

/**
 * State for a pending user input request (AskUserQuestion / ExitPlanMode).
 * The canUseTool callback parks a promise here; the answerQuestion mutation resolves it.
 */
interface PendingUserInput {
  toolName: string;
  input: Record<string, unknown>;
  resolve: (response: { behavior: 'allow'; updatedInput: Record<string, unknown> }) => void;
  reject: (error: Error) => void;
}

/**
 * In-memory state for each active session.
 */
interface SessionState {
  /** Whether a query is currently running */
  isRunning: boolean;
  /** The current Query object (if running), for interruption */
  currentQuery: ReturnType<typeof query> | null;
  /** Pending user input request, if any */
  pendingInput: PendingUserInput | null;
  /** Working directory for this session */
  workingDir: string;
}

/** Active sessions tracked in memory */
const sessions = new Map<string, SessionState>();

// Default system prompt appended to all Claude sessions
export const DEFAULT_SYSTEM_PROMPT = `IMPORTANT: The user is accessing this session remotely through a web interface and has no local access to the files. They can only see your changes through GitHub. Therefore, you MUST follow this workflow for ANY code changes:

1. Always commit your changes with clear, descriptive commit messages
2. Always push your commits to the remote repository
3. If you're working on a new branch or the changes would benefit from review, open a Pull Request using the GitHub CLI (gh pr create)
4. If a PR already exists for the current branch, just push to update it

Never leave uncommitted or unpushed changes - the user cannot see them otherwise.`;

/**
 * Build the full system prompt from global settings and per-repo custom prompt.
 */
export function buildSystemPrompt(options: {
  customSystemPrompt?: string | null;
  globalSettings?: {
    systemPromptOverride: string | null;
    systemPromptOverrideEnabled: boolean;
    systemPromptAppend: string | null;
  } | null;
}): string {
  const { customSystemPrompt, globalSettings } = options;

  let basePrompt = DEFAULT_SYSTEM_PROMPT;
  if (globalSettings?.systemPromptOverrideEnabled && globalSettings.systemPromptOverride) {
    basePrompt = globalSettings.systemPromptOverride;
  }

  let fullSystemPrompt = basePrompt;

  if (globalSettings?.systemPromptAppend) {
    fullSystemPrompt += '\n\n' + globalSettings.systemPromptAppend;
  }

  if (customSystemPrompt) {
    fullSystemPrompt += '\n\n' + customSystemPrompt;
  }

  return fullSystemPrompt;
}

/**
 * Create and save a system error message for display to the user.
 */
async function createErrorMessage(sessionId: string, errorText: string): Promise<void> {
  const lastMessage = await prisma.message.findFirst({
    where: { sessionId },
    orderBy: { sequence: 'desc' },
    select: { sequence: true },
  });

  const sequence = (lastMessage?.sequence ?? -1) + 1;
  const errorId = uuidv5(`${sessionId}:error:${Date.now()}:${errorText}`, ERROR_LINE_NAMESPACE);

  const errorContent = {
    type: 'system',
    subtype: 'error',
    content: [{ type: 'text', text: errorText }],
  };

  try {
    const message = await prisma.message.create({
      data: {
        id: errorId,
        sessionId,
        sequence,
        type: 'system',
        content: JSON.stringify(errorContent),
      },
    });

    sseEvents.emitNewMessage(sessionId, {
      id: message.id,
      sessionId,
      sequence,
      type: 'system',
      content: errorContent,
      createdAt: message.createdAt,
    });
  } catch (err) {
    if (err && typeof err === 'object' && 'code' in err && err.code === 'P2002') {
      return;
    }
    log.error('Failed to create error message', toError(err), { sessionId });
  }
}

/**
 * Get or create session state.
 */
function getSessionState(sessionId: string, workingDir: string): SessionState {
  let state = sessions.get(sessionId);
  if (!state) {
    state = {
      isRunning: false,
      currentQuery: null,
      pendingInput: null,
      workingDir,
    };
    sessions.set(sessionId, state);
  }
  return state;
}

export interface RunClaudeCommandOptions {
  sessionId: string;
  prompt: string;
  workingDir: string;
  /** Optional per-repo custom system prompt appended after the base system prompt */
  customSystemPrompt?: string | null;
  /** Global settings for system prompt override/append */
  globalSettings?: {
    systemPromptOverride: string | null;
    systemPromptOverrideEnabled: boolean;
    systemPromptAppend: string | null;
  } | null;
  /** Claude model override */
  claudeModel?: string | null;
  /** MCP server configurations passed to the SDK */
  mcpServers?: Array<
    | {
        name: string;
        type: 'stdio';
        command: string;
        args?: string[];
        env?: Record<string, string>;
      }
    | { name: string; type: 'http'; url: string; headers?: Record<string, string> }
    | { name: string; type: 'sse'; url: string; headers?: Record<string, string> }
  >;
  /** If true, deny all tool use (safe mode for testing) */
  denyAllTools?: boolean;
}

/**
 * Run a Claude query directly using the Agent SDK.
 * Streams messages, saves them to DB, and emits SSE events.
 */
export async function runClaudeCommand(options: RunClaudeCommandOptions): Promise<void> {
  const { sessionId, prompt, workingDir } = options;
  log.info('runClaudeCommand: Starting', { sessionId, promptLength: prompt.length });

  const state = getSessionState(sessionId, workingDir);

  if (state.isRunning) {
    throw new Error('A Claude process is already running for this session');
  }

  // Look up the session
  const session = await prisma.session.findUnique({
    where: { id: sessionId },
    select: { repoPath: true, repoUrl: true, branch: true, currentBranch: true },
  });

  if (!session) {
    throw new Error('Session not found');
  }

  state.isRunning = true;

  // Build system prompt
  const systemPrompt = buildSystemPrompt({
    customSystemPrompt: options.customSystemPrompt,
    globalSettings: options.globalSettings,
  });

  // Build MCP servers config
  const mcpServersRecord: Record<string, McpServerConfig> | undefined = options.mcpServers?.length
    ? Object.fromEntries(
        options.mcpServers.map((server) => {
          if (server.type === 'http' || server.type === 'sse') {
            const config: McpServerConfig = { type: server.type, url: server.url };
            if (server.headers && Object.keys(server.headers).length > 0) {
              (config as { headers?: Record<string, string> }).headers = server.headers;
            }
            return [server.name, config];
          }
          const config: McpServerConfig = { command: server.command };
          if (server.args?.length) (config as { args?: string[] }).args = server.args;
          if (server.env && Object.keys(server.env).length > 0)
            (config as { env?: Record<string, string> }).env = server.env;
          return [server.name, config];
        })
      )
    : undefined;

  // Determine if we should resume (has existing messages)
  const existingMessages = await prisma.message.count({
    where: { sessionId },
  });
  const shouldResume = existingMessages > 0;

  // Get the next sequence number
  const lastMessage = await prisma.message.findFirst({
    where: { sessionId },
    orderBy: { sequence: 'desc' },
    select: { sequence: true },
  });
  let sequence = (lastMessage?.sequence ?? -1) + 1;

  // Store the user prompt first
  const userMessageId = uuid();
  const userMessageSequence = sequence++;
  const userMessageContent = { type: 'user', content: prompt };
  await prisma.message.create({
    data: {
      id: userMessageId,
      sessionId,
      sequence: userMessageSequence,
      type: 'user',
      content: JSON.stringify(userMessageContent),
    },
  });

  sseEvents.emitNewMessage(sessionId, {
    id: userMessageId,
    sessionId,
    sequence: userMessageSequence,
    type: 'user',
    content: userMessageContent,
    createdAt: new Date(),
  });

  // Emit Claude running event
  sseEvents.emitClaudeRunning(sessionId, true);

  // Build SDK query options
  const denyAllTools = options.denyAllTools ?? false;
  const sdkOptions: Parameters<typeof query>[0]['options'] = {
    permissionMode: 'bypassPermissions' as const,
    allowDangerouslySkipPermissions: true,
    includePartialMessages: true,
    cwd: workingDir,
    settingSources: ['project'],
    systemPrompt: {
      type: 'preset' as const,
      preset: 'claude_code' as const,
      append: systemPrompt,
    },
    tools: { type: 'preset' as const, preset: 'claude_code' as const },
    canUseTool: async (toolName: string, input: Record<string, unknown>) => {
      // In safe mode, deny all tools
      if (denyAllTools) {
        return { behavior: 'deny' as const, message: 'Tool use is disabled in safe mode' };
      }

      // Handle tools that require user input
      if (toolName === 'AskUserQuestion' || toolName === 'ExitPlanMode') {
        log.info('canUseTool: Waiting for user input', { sessionId, toolName });

        // Signal that Claude is waiting for input (not actively running)
        // so the frontend enables the answer UI
        sseEvents.emitClaudeRunning(sessionId, false);

        // Park a promise that will be resolved when the user answers
        try {
          return await new Promise<{ behavior: 'allow'; updatedInput: Record<string, unknown> }>(
            (resolve, reject) => {
              state.pendingInput = { toolName, input, resolve, reject };
            }
          );
        } finally {
          // Resume "running" state after user answers
          sseEvents.emitClaudeRunning(sessionId, true);
        }
      }

      // Auto-approve all other tools (bypass permissions mode)
      return { behavior: 'allow' as const, updatedInput: input };
    },
  };

  // Resume or start fresh
  if (shouldResume) {
    sdkOptions.resume = sessionId;
  } else {
    sdkOptions.sessionId = sessionId;
  }

  // Model configuration
  if (options.claudeModel) {
    sdkOptions.model = options.claudeModel;
  }

  // MCP server configurations
  if (mcpServersRecord && Object.keys(mcpServersRecord).length > 0) {
    sdkOptions.mcpServers = mcpServersRecord;
  }

  try {
    const accumulator = new StreamAccumulator();
    const PARTIAL_MESSAGE_ID_PREFIX = 'partial-';

    // Start the query
    const q = query({ prompt, options: sdkOptions });
    state.currentQuery = q;

    for await (const message of q) {
      // Handle stream_events for partial messages
      if (message.type === 'stream_event') {
        const partial = accumulator.accumulate(
          message as {
            type: 'stream_event';
            event: { type: string; [key: string]: unknown };
            parent_tool_use_id: string | null;
            uuid: string;
            session_id: string;
          }
        );
        if (partial) {
          const partialId = PARTIAL_MESSAGE_ID_PREFIX + partial.uuid;
          sseEvents.emitNewMessage(sessionId, {
            id: partialId,
            sessionId,
            sequence,
            type: 'assistant',
            content: partial,
            createdAt: new Date(),
          });
        }
        continue;
      }

      // Reset accumulator when full assistant message arrives
      if (message.type === 'assistant') {
        accumulator.reset();
      }

      // Persist complete messages
      const messageContent = JSON.stringify(message);
      const messageType = getMessageType(message);
      const msgId = (message as { uuid?: string }).uuid || uuid();

      try {
        const dbMessage = await prisma.message.create({
          data: {
            id: msgId,
            sessionId,
            sequence,
            type: messageType,
            content: messageContent,
          },
        });

        sseEvents.emitNewMessage(sessionId, {
          id: dbMessage.id,
          sessionId,
          sequence,
          type: messageType,
          content: message,
          createdAt: dbMessage.createdAt,
        });

        sequence++;
      } catch (err) {
        if (err && typeof err === 'object' && 'code' in err && err.code === 'P2002') {
          log.debug('Skipping duplicate message', { sessionId, msgId });
          continue;
        }
        throw err;
      }
    }

    log.info('runClaudeCommand: Completed', { sessionId, totalMessages: sequence });
  } catch (err) {
    log.error('runClaudeCommand: Error', toError(err), { sessionId });
    await createErrorMessage(sessionId, `Claude query failed: ${toError(err).message}`);
  } finally {
    state.isRunning = false;
    state.currentQuery = null;

    // Reject any pending user input promise so the SDK doesn't hang
    if (state.pendingInput) {
      state.pendingInput.reject(new Error('Query ended'));
      state.pendingInput = null;
    }

    sessions.delete(sessionId);

    sseEvents.emitClaudeRunning(sessionId, false);

    // Detect branch changes and check for PR updates (fire-and-forget)
    void (async () => {
      try {
        const detectedBranch = await getCurrentBranch(workingDir);

        if (detectedBranch && detectedBranch !== session.currentBranch) {
          const updatedSession = await prisma.session.update({
            where: { id: sessionId },
            data: { currentBranch: detectedBranch },
          });
          sseEvents.emitSessionUpdate(sessionId, updatedSession);
        }

        const branchForPr = detectedBranch ?? session.currentBranch;
        if (session.repoUrl && branchForPr) {
          const repoFullName = extractRepoFullName(session.repoUrl);
          const pr = await fetchPullRequestForBranch(repoFullName, branchForPr);
          if (pr !== undefined) {
            sseEvents.emitPrUpdate(sessionId, pr);
          }
        }
      } catch (err) {
        log.debug('Failed to detect branch or check PR', {
          sessionId,
          error: toError(err).message,
        });
      }
    })();
  }
}

/**
 * Submit an answer to a pending AskUserQuestion or ExitPlanMode tool call.
 * Resolves the parked canUseTool promise so the SDK continues.
 *
 * @returns true if there was a pending input to answer, false otherwise
 */
export function answerUserInput(sessionId: string, answers: Record<string, string>): boolean {
  const state = sessions.get(sessionId);
  if (!state?.pendingInput) {
    log.warn('answerUserInput: No pending input', { sessionId });
    return false;
  }

  const { toolName, input, resolve } = state.pendingInput;
  state.pendingInput = null;

  log.info('answerUserInput: Resolving', { sessionId, toolName });

  if (toolName === 'AskUserQuestion') {
    // Return answers in the format the SDK expects
    resolve({
      behavior: 'allow',
      updatedInput: {
        questions: (input as { questions?: unknown }).questions,
        answers,
      },
    });
  } else if (toolName === 'ExitPlanMode') {
    // For ExitPlanMode, just allow it to proceed
    resolve({
      behavior: 'allow',
      updatedInput: input,
    });
  }

  return true;
}

/**
 * Check if a session has a pending user input request.
 */
export function hasPendingInput(sessionId: string): boolean {
  return sessions.get(sessionId)?.pendingInput != null;
}

/**
 * Get the pending input details for a session (for rendering in the UI on reconnect).
 */
export function getPendingInput(
  sessionId: string
): { toolName: string; input: Record<string, unknown> } | null {
  const state = sessions.get(sessionId);
  if (!state?.pendingInput) return null;
  return {
    toolName: state.pendingInput.toolName,
    input: state.pendingInput.input,
  };
}

/**
 * Interrupt a running Claude query.
 */
export async function interruptClaude(sessionId: string): Promise<boolean> {
  const state = sessions.get(sessionId);
  if (!state?.currentQuery) {
    log.info('interruptClaude: No active query', { sessionId });
    return false;
  }

  try {
    await state.currentQuery.interrupt();
    return true;
  } catch (err) {
    log.warn('interruptClaude: Failed', { sessionId, error: toError(err).message });
    return false;
  }
}

/**
 * Check if Claude is running for a session (in-memory check).
 */
export function isClaudeRunning(sessionId: string): boolean {
  return sessions.get(sessionId)?.isRunning ?? false;
}

/**
 * Check if Claude is running (same as isClaudeRunning since everything is in-process now).
 */
export async function isClaudeRunningAsync(sessionId: string): Promise<boolean> {
  return isClaudeRunning(sessionId);
}

/**
 * Mark the last non-user message as interrupted and add an interrupt indicator.
 */
export async function markLastMessageAsInterrupted(sessionId: string): Promise<void> {
  log.info('markLastMessageAsInterrupted', { sessionId });

  const lastMessage = await prisma.message.findFirst({
    where: { sessionId },
    orderBy: { sequence: 'desc' },
    select: { id: true, sequence: true, type: true, content: true },
  });

  if (!lastMessage) return;

  const lastNonUserMessage = await prisma.message.findFirst({
    where: { sessionId, type: { not: 'user' } },
    orderBy: { sequence: 'desc' },
    select: { id: true, sequence: true, type: true, content: true },
  });

  if (lastNonUserMessage) {
    try {
      const content = JSON.parse(lastNonUserMessage.content);
      content.interrupted = true;
      await prisma.message.update({
        where: { id: lastNonUserMessage.id },
        data: { content: JSON.stringify(content) },
      });

      sseEvents.emitNewMessage(sessionId, {
        id: lastNonUserMessage.id,
        sessionId,
        sequence: lastNonUserMessage.sequence,
        type: lastNonUserMessage.type,
        content,
        createdAt: new Date(),
      });
    } catch (err) {
      log.warn('Failed to mark message as interrupted', {
        sessionId,
        error: toError(err).message,
      });
    }
  }

  const interruptMessageId = uuid();
  const interruptSequence = lastMessage.sequence + 1;
  const interruptContent = {
    type: 'user',
    subtype: 'interrupt',
    content: 'Interrupted',
  };

  await prisma.message.create({
    data: {
      id: interruptMessageId,
      sessionId,
      sequence: interruptSequence,
      type: 'user',
      content: JSON.stringify(interruptContent),
    },
  });

  sseEvents.emitNewMessage(sessionId, {
    id: interruptMessageId,
    sessionId,
    sequence: interruptSequence,
    type: 'user',
    content: interruptContent,
    createdAt: new Date(),
  });
}

/**
 * Stop a session's Claude query and clean up state.
 * Called when a session is stopped.
 */
export function stopSession(sessionId: string): void {
  const state = sessions.get(sessionId);
  if (!state) return;

  if (state.currentQuery) {
    try {
      state.currentQuery.close();
    } catch {
      // Ignore close errors
    }
  }

  // Reject any pending user input
  if (state.pendingInput) {
    state.pendingInput.reject(new Error('Session stopped'));
    state.pendingInput = null;
  }

  state.isRunning = false;
  state.currentQuery = null;
  sessions.delete(sessionId);
}

/**
 * Stop all active Claude queries. Called during graceful shutdown.
 */
export async function stopAllSessions(): Promise<void> {
  const sessionIds = [...sessions.keys()];
  if (sessionIds.length === 0) return;

  log.info('Stopping all active sessions for shutdown', { count: sessionIds.length });
  await Promise.allSettled(sessionIds.map((id) => stopSession(id)));
}

/**
 * Mark all running sessions as stopped.
 * Called on server startup since all in-memory state is lost.
 */
export async function markAllSessionsStopped(): Promise<number> {
  const result = await prisma.session.updateMany({
    where: {
      status: 'running',
    },
    data: {
      status: 'stopped',
    },
  });

  if (result.count > 0) {
    log.info('Marked running sessions as stopped on startup', { count: result.count });
  }

  return result.count;
}
