/**
 * The app's own in-process MCP server, handed to every session's query when
 * enabled in global settings (doc/settings.md "Built-in Tools"). Tools that act
 * on sessions reach the lifecycle and runner only through the {@link SessionToolsPort}
 * handed to {@link initBuiltinMcp}, since the runner imports this module.
 */

import {
  createSdkMcpServer,
  tool,
  type McpSdkServerConfigWithInstance,
} from '@anthropic-ai/claude-agent-sdk';
import { z } from 'zod';
import { prisma } from '@/lib/prisma';
import { processSingleton } from '@/lib/process-singleton';
import { createLogger, toError } from '@/lib/logger';
import { keysetPage, keysetPageInputSchema } from '@/lib/keyset-page';
import { repoFullNameSchema } from '@/lib/repo-full-name';
import { PROMPT_MAX_LENGTH } from '@/lib/types';
import { sessionNameSchema } from '@/lib/session-name';
import { attentionSummarySchema } from '@/lib/session-attention';
import {
  attributeMessage,
  BUILTIN_MCP_SERVER_NAME,
  type BuiltinToolsLevel,
} from '@/lib/builtin-tools';
import {
  fitNewestEntries,
  toTranscriptEntries,
  type TranscriptEntry,
} from '@/lib/session-transcript';
import {
  backgroundResultMessage,
  GPT_AGENT_TIERS,
  GPT_AGENT_TOOL_DESCRIPTION,
} from '@/lib/gpt-agent';
import { runGptAgent, type GptAgentContext } from './gpt-agent';
import { loadHistoryPage } from './message-store';
import { requestAttention } from './session-attention';

const log = createLogger('builtin-mcp');

export interface SessionToolsPort {
  renameSession(sessionId: string, name: string): Promise<void>;
  createSession(input: {
    name: string;
    repoFullName?: string;
    branch?: string;
    initialPrompt: string;
    createdBySessionId: string;
  }): Promise<{ id: string }>;
  /** Resolves to the session's status afterwards, which is unchanged if it wasn't running. */
  stopSession(sessionId: string): Promise<{ status: string }>;
  isTurnActive(sessionId: string): boolean;
  /**
   * Send a message to a session's agent on the app's behalf (not the user's),
   * only if its query is live: never one that would revive a session.
   */
  deliverMessage(sessionId: string, text: string): Promise<void>;
}

const portRef = processSingleton<{ port: SessionToolsPort | null }>('builtin-mcp.port', () => ({
  port: null,
}));

export function initBuiltinMcp(sessionTools: SessionToolsPort): void {
  portRef.port = sessionTools;
}

function requirePort(): SessionToolsPort {
  if (!portRef.port) throw new Error('Built-in session tools are not initialized');
  return portRef.port;
}

const TRANSCRIPT_PAGE_ROWS = 100;
/** Pages to scan for one read; tool-heavy stretches can have little text per page. */
const TRANSCRIPT_MAX_PAGES = 5;
const SUMMARY_CHARS_PER_ENTRY = 1500;
const FULL_CHARS_PER_ENTRY = 20000;
/** Keeps a read well under Claude Code's MCP tool output limit. */
const TRANSCRIPT_BUDGET_CHARS = 40000;

type ToolResult = { content: { type: 'text'; text: string }[]; isError?: boolean };

function textResult(text: string): ToolResult {
  return { content: [{ type: 'text', text }] };
}

function errorResult(text: string): ToolResult {
  return { ...textResult(text), isError: true };
}

/** Run a tool body, turning a thrown error into a tool error the agent can read. */
async function run(toolName: string, body: () => Promise<ToolResult>): Promise<ToolResult> {
  try {
    return await body();
  } catch (err) {
    log.warn('Built-in tool failed', { toolName, error: toError(err).message });
    return errorResult(toError(err).message);
  }
}

const sessionIdSchema = z.string().uuid();
const promptSchema = z.string().trim().min(1).max(PROMPT_MAX_LENGTH);

/** Load the target of a cross-session tool, refusing the caller itself. */
async function loadOtherSession(callerId: string, targetId: string) {
  if (targetId === callerId) throw new Error('This tool acts on other sessions, not your own');
  const target = await prisma.session.findUnique({
    where: { id: targetId },
    select: { id: true, name: true, status: true },
  });
  if (!target) throw new Error(`Session ${targetId} not found`);
  return target;
}

async function loadCaller(sessionId: string) {
  const caller = await prisma.session.findUnique({
    where: { id: sessionId },
    select: { id: true, name: true, agentName: true },
  });
  if (!caller) throw new Error('Calling session not found');
  return caller;
}

function basicTools(sessionId: string) {
  return [
    tool(
      'rename_session',
      'Rename this session as shown in the user’s session list.',
      { name: sessionNameSchema },
      ({ name }) =>
        run('rename_session', async () => {
          await requirePort().renameSession(sessionId, name);
          return textResult(`Renamed this session to "${name}".`);
        }),
      { alwaysLoad: true }
    ),
    tool(
      'notify_user',
      'Flag this session in the user’s session list and send them a notification. Call it when you have something for the user (a result, a finished PR, a question, a blocker), right before ending your turn.',
      { summary: attentionSummarySchema.describe('One line saying what you have for the user') },
      ({ summary }) =>
        run('notify_user', async () => {
          await requestAttention(sessionId, summary);
          return textResult('Notified the user.');
        }),
      { alwaysLoad: true }
    ),
    tool(
      'list_sessions',
      'List the user’s non-archived sessions, most recently used first. agentName is the address to use with SendMessage (null until assigned).',
      { cursor: keysetPageInputSchema.shape.cursor },
      ({ cursor }) =>
        run('list_sessions', async () => {
          const page = keysetPage('lastActivityAt', { cursor, limit: 50 });
          const rows = await prisma.session.findMany({
            where: { status: { not: 'archived' }, ...page.where },
            orderBy: page.orderBy,
            take: page.take,
            select: {
              id: true,
              name: true,
              agentName: true,
              repoUrl: true,
              currentBranch: true,
              status: true,
              lastActivityAt: true,
            },
          });
          const { items, nextCursor } = page.slice(rows);
          const sessions = items.map((s) => ({
            ...s,
            isYou: s.id === sessionId,
            turnActive: requirePort().isTurnActive(s.id),
          }));
          return textResult(JSON.stringify({ sessions, nextCursor }, null, 2));
        })
    ),
  ];
}

function manageTools(sessionId: string) {
  return [
    tool(
      'create_session',
      'Start a new session with its own fresh clone and send it an initial prompt. Only use this when the user asks for a separate session; use subagents for ordinary delegation. Returns the new session id; setup (cloning) continues in the background.',
      {
        name: sessionNameSchema,
        prompt: promptSchema,
        repoFullName: repoFullNameSchema.optional().describe('owner/repo; omit for no repository'),
        branch: z.string().min(1).optional().describe('Required with repoFullName'),
      },
      ({ name, prompt, repoFullName, branch }) =>
        run('create_session', async () => {
          if (repoFullName && !branch) throw new Error('branch is required with repoFullName');
          const caller = await loadCaller(sessionId);
          const created = await requirePort().createSession({
            name,
            repoFullName,
            branch: repoFullName ? branch : undefined,
            initialPrompt: attributeMessage(caller, prompt),
            createdBySessionId: sessionId,
          });
          return textResult(
            `Created session ${created.id}. It will receive the prompt once setup finishes; find its agentName with list_sessions to message it, or check on it with read_session.`
          );
        })
    ),
    tool(
      'read_session',
      'Read another session’s recent conversation, newest last: user prompts and the agent’s replies, each truncated. Set includeToolCalls for tool calls and detail "full" for untruncated text. Page back with the returned cursor.',
      {
        sessionId: sessionIdSchema,
        cursor: z.number().int().optional().describe('Sequence from a previous page'),
        includeToolCalls: z.boolean().default(false),
        detail: z.enum(['summary', 'full']).default('summary'),
      },
      ({ sessionId: targetId, cursor, includeToolCalls, detail }) =>
        run('read_session', async () => {
          const target = await loadOtherSession(sessionId, targetId);
          const maxCharsPerEntry =
            detail === 'full' ? FULL_CHARS_PER_ENTRY : SUMMARY_CHARS_PER_ENTRY;
          let entries: TranscriptEntry[] = [];
          let pageCursor = cursor;
          let hasMore = true;
          let fit = fitNewestEntries(entries, maxCharsPerEntry, TRANSCRIPT_BUDGET_CHARS);
          for (let page = 0; page < TRANSCRIPT_MAX_PAGES && hasMore && fit.complete; page++) {
            const history = await loadHistoryPage(target.id, pageCursor, TRANSCRIPT_PAGE_ROWS);
            entries = [...toTranscriptEntries(history.messages, { includeToolCalls }), ...entries];
            hasMore = history.hasMore;
            pageCursor = history.messages[0]?.sequence;
            fit = fitNewestEntries(entries, maxCharsPerEntry, TRANSCRIPT_BUDGET_CHARS);
          }
          const header = {
            name: target.name,
            status: target.status,
            turnActive: requirePort().isTurnActive(target.id),
            nextCursor: fit.complete ? (hasMore ? pageCursor : undefined) : fit.oldestSequence,
          };
          return textResult(
            `${JSON.stringify(header)}\n\n${fit.text || '(no conversation in this range)'}`
          );
        })
    ),
    tool(
      'stop_session',
      'Stop another session’s agent (its workspace is kept and the user can restart it). Only when the user asks.',
      { sessionId: sessionIdSchema },
      ({ sessionId: targetId }) =>
        run('stop_session', async () => {
          const target = await loadOtherSession(sessionId, targetId);
          const { status } = await requirePort().stopSession(target.id);
          if (status !== 'stopped') {
            throw new Error(`Session "${target.name}" is ${status} and can't be stopped`);
          }
          return textResult(`Stopped "${target.name}".`);
        })
    ),
  ];
}

/** The tool call's abort signal (set by the MCP SDK; the type says unknown). */
function callSignal(extra: unknown): AbortSignal | undefined {
  const signal = (extra as { signal?: unknown } | null)?.signal;
  return signal instanceof AbortSignal ? signal : undefined;
}

function gptTools(ctx: GptAgentContext) {
  return [
    tool(
      'gpt_agent',
      GPT_AGENT_TOOL_DESCRIPTION,
      {
        model: z.enum(GPT_AGENT_TIERS),
        description: z
          .string()
          .trim()
          .min(1)
          .max(100)
          .describe('A short (3-5 word) description of the task'),
        prompt: promptSchema,
        run_in_background: z.boolean().default(false),
      },
      ({ model, description, prompt, run_in_background }, extra) =>
        run('gpt_agent', async () => {
          if (!run_in_background) {
            const outcome = await runGptAgent(ctx, model, prompt, callSignal(extra));
            return outcome.isError ? errorResult(outcome.text) : textResult(outcome.text);
          }
          void runGptAgent(ctx, model, prompt)
            .then(async (outcome) => {
              if (outcome.cancelled) return;
              await requirePort().deliverMessage(
                ctx.sessionId,
                backgroundResultMessage(model, description, outcome)
              );
            })
            .catch((err) =>
              log.warn('Could not deliver a background GPT agent result', {
                sessionId: ctx.sessionId,
                error: toError(err).message,
              })
            );
          return textResult(
            `Started the GPT agent "${description}" (${model}) in the background. Its result will arrive as a message; don't wait for it or poll.`
          );
        }),
      { alwaysLoad: true }
    ),
  ];
}

/**
 * A fresh server instance; one instance can serve only one query. Null when the
 * session gets no built-in tools at all.
 */
export function buildBuiltinMcpServer(
  sessionId: string,
  level: BuiltinToolsLevel | null,
  gpt: GptAgentContext | null
): McpSdkServerConfigWithInstance | null {
  if (!level && !gpt) return null;
  return createSdkMcpServer({
    name: BUILTIN_MCP_SERVER_NAME,
    tools: [
      ...(level ? basicTools(sessionId) : []),
      ...(level === 'manage' ? manageTools(sessionId) : []),
      ...(gpt ? gptTools(gpt) : []),
    ],
  });
}
