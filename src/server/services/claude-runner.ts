import { prisma } from '@/lib/prisma';
import { getMessageType } from '@/lib/claude-messages';
import { v4 as uuid, v5 as uuidv5 } from 'uuid';
import { sseEvents } from './events';
import { createLogger, toError } from '@/lib/logger';
import {
  describeExitCode,
  getContainerStatus,
  getContainerState,
  getContainerLogs,
} from './podman';
import {
  createAgentClient,
  getAgentUrl,
  waitForAgentHealth,
  type AgentClient,
} from './agent-client';

// Namespace UUID for generating deterministic IDs from error line content
const ERROR_LINE_NAMESPACE = '6ba7b810-9dad-11d1-80b4-00c04fd430c8';

// Track active queries per session (in-memory for quick lookups)
const activeQueries = new Map<string, { client: AgentClient }>();

// Default system prompt appended to all Claude sessions to ensure proper workflow
// Since users interact through GitHub PRs (no local access), Claude must always
// commit, push, and open PRs for any changes to be visible
// This is exported so the UI can display it when setting up an override
export const DEFAULT_SYSTEM_PROMPT = `IMPORTANT: The user is accessing this session remotely through a web interface and has no local access to the files. They can only see your changes through GitHub. Therefore, you MUST follow this workflow for ANY code changes:

1. Always commit your changes with clear, descriptive commit messages
2. Always push your commits to the remote repository
3. If you're working on a new branch or the changes would benefit from review, open a Pull Request using the GitHub CLI (gh pr create)
4. If a PR already exists for the current branch, just push to update it

Never leave uncommitted or unpushed changes - the user cannot see them otherwise.

CONTAINER ENVIRONMENT: This container uses Podman for container operations (not Docker). Use \`podman\` and \`podman-compose\` commands for container management. Aliases for \`docker\` and \`docker-compose\` are available and will work, but prefer using the podman commands directly. You have passwordless sudo access for installing additional packages if needed.

CONTAINER ISSUE REPORTING: This container should have all standard development tools pre-installed and properly configured. If you encounter missing tools, misconfigured environments, or other container setup issues that prevent you from completing tasks:

1. First, check if the issue has already been reported by searching existing issues: \`gh issue list --repo brendanlong/clawed-abode --search "<issue description>" --state all\`
2. If no existing issue matches, report it to the clawed-abode repository: \`gh issue create --repo brendanlong/clawed-abode --title "<brief description>" --body "<detailed description of the problem and what you were trying to do>" --label bug --label reported-by-claude\`
3. Then continue with your task using workarounds if possible, or inform the user that the task cannot be completed due to the container issue.`;

const log = createLogger('claude-runner');

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

  // Start with either the global override (if enabled) or the default prompt
  let basePrompt = DEFAULT_SYSTEM_PROMPT;
  if (globalSettings?.systemPromptOverrideEnabled && globalSettings.systemPromptOverride) {
    basePrompt = globalSettings.systemPromptOverride;
  }

  let fullSystemPrompt = basePrompt;

  // Add global append content
  if (globalSettings?.systemPromptAppend) {
    fullSystemPrompt += '\n\n' + globalSettings.systemPromptAppend;
  }

  // Add per-repo custom prompt
  if (customSystemPrompt) {
    fullSystemPrompt += '\n\n' + customSystemPrompt;
  }

  return fullSystemPrompt;
}

/**
 * Create and save a system error message for display to the user.
 * Used when Claude process fails unexpectedly.
 */
async function createErrorMessage(
  sessionId: string,
  errorText: string,
  details?: {
    exitCode?: number | null;
    containerLogs?: string | null;
  }
): Promise<void> {
  const lastMessage = await prisma.message.findFirst({
    where: { sessionId },
    orderBy: { sequence: 'desc' },
    select: { sequence: true },
  });

  const sequence = (lastMessage?.sequence ?? -1) + 1;
  const errorId = uuidv5(`${sessionId}:error:${Date.now()}:${errorText}`, ERROR_LINE_NAMESPACE);

  // Build detailed error content
  let fullText = errorText;
  if (details?.exitCode !== undefined && details.exitCode !== null && details.exitCode !== 0) {
    fullText += `\n\nExit code: ${details.exitCode} (${describeExitCode(details.exitCode)})`;
  }
  if (details?.containerLogs) {
    // Truncate logs if too long
    const maxLogLength = 2000;
    const logs =
      details.containerLogs.length > maxLogLength
        ? details.containerLogs.slice(-maxLogLength) + '\n...(truncated)'
        : details.containerLogs;
    fullText += `\n\nContainer logs:\n${logs}`;
  }

  const errorContent = {
    type: 'system',
    subtype: 'error',
    content: [{ type: 'text', text: fullText }],
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

    log.info('Created error message', { sessionId, errorId, sequence });
  } catch (err) {
    // Ignore duplicate errors
    if (err && typeof err === 'object' && 'code' in err && err.code === 'P2002') {
      return;
    }
    log.error('Failed to create error message', toError(err), { sessionId });
  }
}

/**
 * Check container health and create error message if container has failed.
 * Returns true if container is healthy, false if it has failed.
 */
async function checkContainerHealthAndReport(
  sessionId: string,
  containerId: string
): Promise<boolean> {
  const containerState = await getContainerState(containerId);

  if (containerState.status === 'not_found') {
    log.error('Container not found during health check', undefined, {
      sessionId,
      containerId,
    });

    await createErrorMessage(sessionId, 'Container was terminated unexpectedly.', {
      exitCode: null,
    });
    return false;
  }

  if (containerState.status === 'stopped') {
    log.error('Container stopped unexpectedly', undefined, {
      sessionId,
      containerId,
      exitCode: containerState.exitCode,
      error: containerState.error,
      oomKilled: containerState.oomKilled,
    });

    let errorText = 'Container stopped unexpectedly.';
    if (containerState.oomKilled) {
      errorText = 'Container was killed due to out of memory.';
    } else if (containerState.error) {
      errorText = `Container stopped with error: ${containerState.error}`;
    }

    const containerLogs = await getContainerLogs(containerId, { tail: 50 });
    await createErrorMessage(sessionId, errorText, {
      exitCode: containerState.exitCode,
      containerLogs,
    });
    return false;
  }

  return true;
}

/**
 * Get an agent client for a session.
 * The session must have an agentPort assigned.
 */
function getClientForSession(agentPort: number): AgentClient {
  return createAgentClient(getAgentUrl(agentPort));
}

export interface RunClaudeCommandOptions {
  sessionId: string;
  containerId: string;
  prompt: string;
  /** Optional per-repo custom system prompt appended after the base system prompt */
  customSystemPrompt?: string | null;
  /** Global settings for system prompt override/append */
  globalSettings?: {
    systemPromptOverride: string | null;
    systemPromptOverrideEnabled: boolean;
    systemPromptAppend: string | null;
  } | null;
  /** MCP server configurations passed to the SDK at query time */
  mcpServers?: Array<{
    name: string;
    command: string;
    args?: string[];
    env?: Record<string, string>;
  }>;
}

/**
 * Run a Claude command via the agent service running inside the container.
 * Streams messages from the agent service, saves them to DB, and emits SSE events.
 */
export async function runClaudeCommand(options: RunClaudeCommandOptions): Promise<void> {
  const { sessionId, containerId, prompt } = options;
  log.info('runClaudeCommand: Starting', { sessionId, containerId, promptLength: prompt.length });

  // Check if session already has a running query
  if (activeQueries.has(sessionId)) {
    log.warn('runClaudeCommand: Query already running', { sessionId });
    throw new Error('A Claude process is already running for this session');
  }

  // Look up the session to get the agentPort
  const session = await prisma.session.findUnique({
    where: { id: sessionId },
    select: { agentPort: true, repoPath: true },
  });

  if (!session?.agentPort) {
    throw new Error('Session does not have an agent port assigned');
  }

  // Verify the container is still running
  const containerStatus = await getContainerStatus(containerId);
  if (containerStatus !== 'running') {
    throw new Error(
      `Cannot execute Claude command: container is ${containerStatus === 'not_found' ? 'not found' : 'stopped'}`
    );
  }

  // Get the agent client
  const client = getClientForSession(session.agentPort);

  // Check if agent service is healthy
  const healthy = await client.health();
  if (!healthy) {
    throw new Error('Agent service is not healthy');
  }

  // Check if agent already has a running query
  const status = await client.getStatus();
  if (status.running) {
    throw new Error('A Claude process is already running for this session');
  }

  // Get the next sequence number for this session
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

  // Emit SSE event for the user message
  sseEvents.emitNewMessage(sessionId, {
    id: userMessageId,
    sessionId,
    sequence: userMessageSequence,
    type: 'user',
    content: userMessageContent,
    createdAt: new Date(),
  });

  // Determine if we should resume an existing SDK session.
  // We ask the agent service for its last sequence number. If it has processed
  // messages before (sequence > 0), it has an active Claude Code session
  // that we can resume. If it's 0 (fresh container), we start a new session
  // even if our DB has messages from a previous container lifecycle.
  const shouldResume = status.lastSequence > 0;

  // Track the active query
  activeQueries.set(sessionId, { client });

  // Emit Claude running event
  sseEvents.emitClaudeRunning(sessionId, true);

  try {
    // Build working directory
    const workingDir = session.repoPath ? `/workspace/${session.repoPath}` : '/workspace';

    // Build MCP servers config as Record<string, McpServerConfig> for the SDK
    const mcpServersRecord = options.mcpServers?.length
      ? Object.fromEntries(
          options.mcpServers.map((server) => {
            const config: Record<string, unknown> = { command: server.command };
            if (server.args?.length) config.args = server.args;
            if (server.env && Object.keys(server.env).length > 0) config.env = server.env;
            return [server.name, config];
          })
        )
      : undefined;

    // Start the query through the agent service
    for await (const agentMessage of client.query({
      prompt,
      sessionId,
      resume: shouldResume,
      cwd: workingDir,
      mcpServers: mcpServersRecord,
    })) {
      const messageContent = JSON.stringify(agentMessage.message);
      const messageType = getMessageType(agentMessage.message);
      const msgId = (agentMessage.message as { uuid?: string }).uuid || uuid();

      // Save to database
      try {
        const message = await prisma.message.create({
          data: {
            id: msgId,
            sessionId,
            sequence,
            type: messageType,
            content: messageContent,
          },
        });

        // Emit SSE event
        sseEvents.emitNewMessage(sessionId, {
          id: message.id,
          sessionId,
          sequence,
          type: messageType,
          content: agentMessage.message,
          createdAt: message.createdAt,
        });

        sequence++;
      } catch (err) {
        // Handle unique constraint violations (duplicate messages)
        if (err && typeof err === 'object' && 'code' in err && err.code === 'P2002') {
          log.debug('runClaudeCommand: Skipping duplicate message', { sessionId, msgId });
          continue;
        }
        throw err;
      }
    }

    log.info('runClaudeCommand: Completed', { sessionId, totalMessages: sequence });
  } catch (err) {
    log.error('runClaudeCommand: Error', toError(err), { sessionId });

    // Fetch container logs for debugging
    const containerLogs = await getContainerLogs(containerId, { tail: 50 });
    if (containerLogs) {
      log.error('runClaudeCommand: Container logs after error', undefined, {
        sessionId,
        logs: containerLogs,
      });
    }

    // Check if container is still healthy
    await checkContainerHealthAndReport(sessionId, containerId);

    // Create error message for the user (includes logs for visibility)
    await createErrorMessage(sessionId, `Claude query failed: ${toError(err).message}`, {
      containerLogs,
    });
  } finally {
    activeQueries.delete(sessionId);

    // Emit Claude stopped event
    sseEvents.emitClaudeRunning(sessionId, false);
    log.debug('runClaudeCommand: Cleanup complete', { sessionId });
  }
}

/**
 * Interrupt a running Claude query via the agent service.
 */
export async function interruptClaude(sessionId: string): Promise<boolean> {
  log.info('interruptClaude: Interrupt requested', { sessionId });

  // Check in-memory active queries first
  const active = activeQueries.get(sessionId);
  if (active) {
    const result = await active.client.interrupt();
    return result.success;
  }

  // Fall back to looking up the session's agent port
  const session = await prisma.session.findUnique({
    where: { id: sessionId },
    select: { agentPort: true, containerId: true },
  });

  if (!session?.agentPort || !session.containerId) {
    log.info('interruptClaude: No agent port or container for session', { sessionId });
    return false;
  }

  // Verify container is running
  const containerStatus = await getContainerStatus(session.containerId);
  if (containerStatus !== 'running') {
    log.info('interruptClaude: Container not running', { sessionId, containerStatus });
    return false;
  }

  const client = getClientForSession(session.agentPort);
  try {
    const result = await client.interrupt();
    return result.success;
  } catch (err) {
    log.warn('interruptClaude: Failed to interrupt', {
      sessionId,
      error: toError(err).message,
    });
    return false;
  }
}

/**
 * Check if Claude is running for a session (in-memory check).
 */
export function isClaudeRunning(sessionId: string): boolean {
  return activeQueries.has(sessionId);
}

/**
 * Check if Claude is running, including checking the agent service.
 * More thorough than isClaudeRunning() but involves a network call.
 */
export async function isClaudeRunningAsync(sessionId: string): Promise<boolean> {
  // Check in-memory first
  if (activeQueries.has(sessionId)) {
    return true;
  }

  // Look up the session's agent port
  const session = await prisma.session.findUnique({
    where: { id: sessionId },
    select: { agentPort: true, containerId: true },
  });

  if (!session?.agentPort || !session.containerId) {
    return false;
  }

  // Check container status
  const containerStatus = await getContainerStatus(session.containerId);
  if (containerStatus !== 'running') {
    return false;
  }

  // Ask the agent service directly
  try {
    const client = getClientForSession(session.agentPort);
    const status = await client.getStatus();
    return status.running;
  } catch {
    return false;
  }
}

/**
 * Mark the last non-user message as potentially interrupted and add an interrupt indicator message.
 * Called after successfully sending interrupt to the agent service.
 */
export async function markLastMessageAsInterrupted(sessionId: string): Promise<void> {
  log.info('markLastMessageAsInterrupted: Marking message as interrupted', { sessionId });

  // Get the last message to find the current max sequence
  const lastMessage = await prisma.message.findFirst({
    where: { sessionId },
    orderBy: { sequence: 'desc' },
    select: { id: true, sequence: true, type: true, content: true },
  });

  if (!lastMessage) {
    log.warn('markLastMessageAsInterrupted: No messages found', { sessionId });
    return;
  }

  // Find the last non-user message to mark as interrupted
  const lastNonUserMessage = await prisma.message.findFirst({
    where: {
      sessionId,
      type: { not: 'user' },
    },
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
      log.debug('markLastMessageAsInterrupted: Marked message as interrupted', {
        sessionId,
        messageId: lastNonUserMessage.id,
        type: lastNonUserMessage.type,
      });

      // Emit update for the modified message
      sseEvents.emitNewMessage(sessionId, {
        id: lastNonUserMessage.id,
        sessionId,
        sequence: lastNonUserMessage.sequence,
        type: lastNonUserMessage.type,
        content,
        createdAt: new Date(),
      });
    } catch (err) {
      log.warn('markLastMessageAsInterrupted: Failed to parse message content', {
        sessionId,
        messageId: lastNonUserMessage.id,
        error: toError(err).message,
      });
    }
  }

  // Add an interrupt indicator message
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

  log.info('markLastMessageAsInterrupted: Added interrupt message', {
    sessionId,
    messageId: interruptMessageId,
    sequence: interruptSequence,
  });

  // Emit the new interrupt message
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
 * Reconcile running sessions on startup.
 * For each running session with an agent port, checks the agent service
 * and catches up on any missed messages.
 */
export async function reconcileOrphanedProcesses(): Promise<{
  total: number;
  reconnected: number;
  cleaned: number;
}> {
  // Find running sessions with agent ports
  const runningSessions = await prisma.session.findMany({
    where: {
      status: 'running',
      agentPort: { not: null },
      containerId: { not: null },
    },
    select: {
      id: true,
      agentPort: true,
      containerId: true,
    },
  });

  let reconnected = 0;
  let cleaned = 0;

  for (const session of runningSessions) {
    if (!session.agentPort || !session.containerId) continue;

    log.info('Reconciling session', { sessionId: session.id });

    try {
      // Check if container is running
      const containerStatus = await getContainerStatus(session.containerId);
      if (containerStatus !== 'running') {
        log.info('Container not running, checking health', {
          sessionId: session.id,
          containerStatus,
        });
        await checkContainerHealthAndReport(session.id, session.containerId);
        cleaned++;
        continue;
      }

      // Try to connect to agent service
      const client = getClientForSession(session.agentPort);
      const healthy = await waitForAgentHealth(client, { maxAttempts: 5, intervalMs: 1000 });

      if (!healthy) {
        log.warn('Agent service not healthy during reconciliation', {
          sessionId: session.id,
          agentPort: session.agentPort,
        });
        cleaned++;
        continue;
      }

      // Get the agent's status and catch up on any missed messages
      const agentStatus = await client.getStatus();

      // Get our last stored sequence
      const lastMessage = await prisma.message.findFirst({
        where: { sessionId: session.id },
        orderBy: { sequence: 'desc' },
        select: { sequence: true },
      });
      const lastSequence = lastMessage?.sequence ?? 0;

      // Fetch any messages we missed
      if (agentStatus.lastSequence > 0) {
        const missedMessages = await client.getMessages(0); // Get all from agent
        let sequence = lastSequence + 1;

        for (const agentMsg of missedMessages) {
          const messageContent = JSON.stringify(agentMsg.message);
          const messageType = getMessageType(agentMsg.message);
          const msgId = (agentMsg.message as { uuid?: string }).uuid || uuid();

          try {
            const message = await prisma.message.create({
              data: {
                id: msgId,
                sessionId: session.id,
                sequence,
                type: messageType,
                content: messageContent,
              },
            });
            sseEvents.emitNewMessage(session.id, {
              id: message.id,
              sessionId: session.id,
              sequence,
              type: messageType,
              content: agentMsg.message,
              createdAt: message.createdAt,
            });
            sequence++;
          } catch (err) {
            // Skip duplicates
            if (err && typeof err === 'object' && 'code' in err && err.code === 'P2002') {
              continue;
            }
            log.warn('Failed to save missed message during reconciliation', {
              sessionId: session.id,
              error: toError(err).message,
            });
          }
        }
      }

      if (agentStatus.running) {
        log.info('Session has active query, marking as reconnected', { sessionId: session.id });
        reconnected++;
      } else {
        log.info('Session agent service is idle', { sessionId: session.id });
        reconnected++;
      }
    } catch (err) {
      log.error('Error reconciling session', toError(err), { sessionId: session.id });
      cleaned++;
    }
  }

  return {
    total: runningSessions.length,
    reconnected,
    cleaned,
  };
}
