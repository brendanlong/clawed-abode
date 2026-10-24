/**
 * The app's own in-process MCP server, handed to every session's query when
 * enabled in settings (doc/settings.md "Built-in Tools"). Tools that act
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
  NOTIFY_USER_TOOL_NAME,
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
import {
  GENERATE_IMAGE_TOOL_DESCRIPTION,
  IMAGE_BACKGROUNDS,
  IMAGE_MODEL_NAMES,
  IMAGE_SIZES,
  MAX_INPUT_IMAGES,
} from '@/lib/image-generation';
import { DEFAULT_USAGE_ALERT_PERCENT, usageAlertPercentSchema } from '@/lib/usage';
import { formatWatchedPullRequest } from '@/lib/pull-request-watch';
import { formatAlertList } from '@/lib/security-alerts';
import { extractRepoFullName } from '@/lib/utils';
import { runGptAgent, type GptAgentContext } from './gpt-agent';
import { generateImage, type ImageToolContext } from './image-generation';
import { loadTranscriptRows } from './message-store';
import { requestAttention } from './session-attention';
import { getUsageReport, setUsageAlerts } from './usage';
import {
  findOwnPullRequest,
  setPullRequestWatches,
  unwatchPullRequest,
  watchPullRequest,
} from './pull-request-watch';
import {
  setSecurityAlertWatches,
  stopSecurityAlertWatches,
  type RepoAlerts,
} from './security-alert-watch';

const log = createLogger('builtin-mcp');

export interface SessionToolsPort {
  renameSession(sessionId: string, name: string): Promise<void>;
  createSession(input: {
    name: string;
    repoFullName?: string;
    branch?: string;
    initialPrompt: string;
  }): Promise<{ id: string }>;
  /** Resolves to the session's status afterwards, which is unchanged if it wasn't running. */
  stopSession(sessionId: string): Promise<{ status: string }>;
  isTurnActive(sessionId: string): boolean;
  /** Mid-turn, the notification is `held` until the turn ends. */
  notifyUser(sessionId: string, summary: string): Promise<{ held: boolean }>;
  /**
   * Send a message to a session's agent on the app's behalf (not the user's),
   * only if its query is live: never one that would revive a session.
   */
  deliverMessage(sessionId: string, text: string): Promise<boolean>;
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

const MAX_WATCHED_REPOS = 20;

const TRANSCRIPT_PAGE_ROWS = 100;
/** Pages to scan for one read; a page of tool calls has little text without includeToolCalls. */
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

async function loadSessionRepo(sessionId: string): Promise<string> {
  const session = await prisma.session.findUnique({
    where: { id: sessionId },
    select: { repoUrl: true },
  });
  if (!session?.repoUrl) throw new Error('This session has no repository; pass repo');
  return extractRepoFullName(session.repoUrl);
}

function formatRepoAlerts(read: RepoAlerts): string {
  const unread = read.failures.map((f) => `Couldn't read ${f.kind} alerts: ${f.message}`);
  return [
    `## ${read.repoFullName}`,
    formatAlertList(Object.values(read.alerts).flat()),
    ...unread,
  ].join('\n');
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
      NOTIFY_USER_TOOL_NAME,
      'Flag this session in the user’s session list and send them a notification. Call it when you have something for the user (a result, a finished PR, a question, a blocker), then write your final message to end the turn.',
      { summary: attentionSummarySchema.describe('One line saying what you have for the user') },
      ({ summary }) =>
        run(NOTIFY_USER_TOOL_NAME, async () => {
          const { held } = await requirePort().notifyUser(sessionId, summary);
          return textResult(
            held ? 'The user will be notified when this turn ends.' : 'Notified the user.'
          );
        }),
      { alwaysLoad: true }
    ),
    tool(
      'stop_this_session',
      'Last resort: stop this session’s agent, ending your work until the user restarts it (the workspace is kept). Only use it when messages keep waking you and the tool that set them up can’t turn them off (set_usage_alerts with enabled false, watch_pull_requests with [], watch_pull_request or watch_security_alerts with stop), or when the user asks. Commit and push first; the user is notified with your reason.',
      {
        reason: attentionSummarySchema.describe('One line telling the user why you stopped'),
      },
      ({ reason }) =>
        run('stop_this_session', async () => {
          const { status } = await requirePort().stopSession(sessionId);
          if (status !== 'stopped')
            throw new Error(`This session is ${status} and can't be stopped`);
          await requestAttention(sessionId, reason);
          return textResult('Stopped this session.');
        })
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
    tool(
      'check_usage',
      'Show how much of the Claude subscription’s usage limits is used: the 5-hour window and the weekly windows (overall and per model), with when each resets. Usage is shared by every session and subagent on the account. asOf is when the figures were last observed.',
      {},
      () =>
        run('check_usage', async () =>
          textResult(JSON.stringify(await getUsageReport(sessionId), null, 2))
        )
    ),
    tool(
      'set_usage_alerts',
      'Turn usage alerts on or off for this session. While on, you get a message when usage of the 5-hour or a weekly window reaches its threshold, once per window, but only while you or a background task of yours is working; otherwise it waits for your next turn. Null for a threshold turns that kind of alert off.',
      {
        enabled: z.boolean(),
        fiveHourPercent: usageAlertPercentSchema.nullable().default(DEFAULT_USAGE_ALERT_PERCENT),
        weeklyPercent: usageAlertPercentSchema.nullable().default(DEFAULT_USAGE_ALERT_PERCENT),
      },
      ({ enabled, fiveHourPercent, weeklyPercent }) =>
        run('set_usage_alerts', async () => {
          const thresholds = enabled
            ? { fiveHour: fiveHourPercent, weekly: weeklyPercent }
            : { fiveHour: null, weekly: null };
          await setUsageAlerts(sessionId, thresholds);
          const report = await getUsageReport(sessionId);
          return textResult(
            `${enabled ? 'Usage alerts set' : 'Usage alerts off'}. Windows already past a threshold won't alert again until they reset.\n\n${JSON.stringify(report, null, 2)}`
          );
        })
    ),
    tool(
      'watch_pull_requests',
      'Set the GitHub repos whose pull requests this session watches, replacing any earlier list; [] stops watching. While watching, you get a message when a PR in them becomes ready (open, not a draft, CI finished) at a new head commit, or is merged or closed, naming the sessions that wrote it, and when people (not bots) comment on one. Comments are not filtered by author, so yours come back too. Returns the open PRs now.',
      { repos: z.array(repoFullNameSchema).max(MAX_WATCHED_REPOS).describe('owner/repo names') },
      ({ repos }) =>
        run('watch_pull_requests', async () => {
          const open = await setPullRequestWatches(sessionId, repos);
          if (repos.length === 0) return textResult('Stopped watching pull requests.');
          const list = open.length > 0 ? open.map(formatWatchedPullRequest).join('\n') : '(none)';
          return textResult(`Watching ${repos.join(', ')}. Open pull requests:\n\n${list}`);
        })
    ),
    tool(
      'watch_security_alerts',
      'Watch GitHub repos’ open Dependabot, code scanning and secret scanning alerts, replacing any earlier list; set stop to end. Returns the open alerts now. While watching, you get one message every few minutes listing what changed: alerts that are new or reopened, and ones that were fixed, dismissed or resolved (including by you). Record each triage decision in GitHub (dismiss with a reason and comment, or fix in a PR) so that open means not yet triaged.',
      {
        repos: z
          .array(repoFullNameSchema)
          .min(1)
          .max(MAX_WATCHED_REPOS)
          .optional()
          .describe('owner/repo names; required unless stopping'),
        stop: z.boolean().default(false),
      },
      ({ repos, stop }) =>
        run('watch_security_alerts', async () => {
          if (stop) {
            await stopSecurityAlertWatches(sessionId);
            return textResult('Stopped watching security alerts.');
          }
          if (!repos) throw new Error('Pass repos, or stop');
          const reads = await setSecurityAlertWatches(sessionId, repos);
          return textResult(
            `Watching security alerts in ${repos.join(', ')}. Open alerts:\n\n${reads.map(formatRepoAlerts).join('\n\n')}`
          );
        })
    ),
    tool(
      'watch_pull_request',
      'Watch one pull request, by default the one for your current branch, instead of polling gh or sleeping: end your turn, and you get a message when its CI finishes on a new head commit (drafts included), when people (not bots, but including you) comment on it, and when it is merged or closed, which ends the watch. Returns its current state. Set stop to end the watch early.',
      {
        number: z
          .number()
          .int()
          .positive()
          .optional()
          .describe('The PR number; defaults to the PR for this session’s current branch'),
        repo: repoFullNameSchema.optional().describe('owner/repo; defaults to this session’s repo'),
        stop: z.boolean().default(false),
      },
      ({ number: givenNumber, repo, stop }) =>
        run('watch_pull_request', async () => {
          if (repo && givenNumber === undefined) {
            throw new Error('Pass number along with repo');
          }
          const { repoFullName, number } =
            givenNumber === undefined
              ? await findOwnPullRequest(sessionId)
              : { repoFullName: repo ?? (await loadSessionRepo(sessionId)), number: givenNumber };
          if (stop) {
            await unwatchPullRequest(sessionId, repoFullName, number);
            return textResult(`Stopped watching ${repoFullName}#${number}.`);
          }
          const { pullRequest, watching } = await watchPullRequest(sessionId, repoFullName, number);
          const state = formatWatchedPullRequest(pullRequest);
          return textResult(
            watching
              ? `Watching ${repoFullName}#${number}. Now:\n\n${state}`
              : `${repoFullName}#${number} is already finished, so it isn't being watched:\n\n${state}`
          );
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
            const history = await loadTranscriptRows(target.id, pageCursor, TRANSCRIPT_PAGE_ROWS);
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

function imageTools(ctx: ImageToolContext) {
  return [
    tool(
      'generate_image',
      GENERATE_IMAGE_TOOL_DESCRIPTION,
      {
        prompt: promptSchema,
        model: z.enum(IMAGE_MODEL_NAMES).default(IMAGE_MODEL_NAMES[0]),
        input_images: z
          .array(z.string().min(1))
          .max(MAX_INPUT_IMAGES)
          .default([])
          .describe('Paths of images to edit or use as references'),
        size: z
          .enum(IMAGE_SIZES)
          .default('auto')
          .describe('A hint; the model may pick another size'),
        background: z.enum(IMAGE_BACKGROUNDS).default('auto'),
        output_path: z
          .string()
          .min(1)
          .optional()
          .describe("Where to save the image; defaults to the session's public directory"),
      },
      ({ prompt, model, input_images, size, background, output_path }, extra) =>
        run('generate_image', async () => {
          const result = await generateImage(
            ctx,
            {
              prompt,
              model,
              inputImages: input_images,
              size,
              background,
              outputPath: output_path,
            },
            callSignal(extra)
          );
          return textResult(JSON.stringify(result, null, 2));
        })
    ),
  ];
}

/**
 * A fresh server instance; one instance can serve only one query. Null when the
 * session gets no built-in tools at all.
 */
export function buildBuiltinMcpServer(
  sessionId: string,
  tools: {
    level: BuiltinToolsLevel | null;
    gpt: GptAgentContext | null;
    images: ImageToolContext | null;
  }
): McpSdkServerConfigWithInstance | null {
  const { level, gpt, images } = tools;
  if (!level && !gpt && !images) return null;
  return createSdkMcpServer({
    name: BUILTIN_MCP_SERVER_NAME,
    tools: [
      ...(level ? basicTools(sessionId) : []),
      ...(level === 'manage' ? manageTools(sessionId) : []),
      ...(gpt ? gptTools(gpt) : []),
      ...(images ? imageTools(images) : []),
    ],
  });
}
