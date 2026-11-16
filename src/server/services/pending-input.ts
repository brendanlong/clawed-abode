import type { PermissionResult } from '@anthropic-ai/claude-agent-sdk';
import { createLogger, toError } from '@/lib/logger';
import {
  PERMISSION_DENIED_MESSAGE,
  permissionAttentionSummary,
  type PermissionRequest,
} from '@/lib/permission-request';
import { interactiveToolAttentionSummary } from '@/lib/session-attention';
import type { ToolResponse } from '@/lib/tool-response';
import { sseEvents } from './events';
import { bumpSessionActivity } from './message-store';
import type { UserInputRequest } from './sdk-options';
import { requestAttention } from './session-attention';
import type { LiveQuery, PendingUserInput } from './session-state';

const log = createLogger('pending-input');

/** The permission requests a session's clients show, in the order they parked. */
export function permissionRequestsOf(live: LiveQuery | null): PermissionRequest[] {
  if (!live) return [];
  return [...live.pendingInputs.values()].flatMap((pending) => {
    if (pending.kind !== 'permission') return [];
    const { kind: _kind, resolve: _resolve, reject: _reject, ...request } = pending;
    return [request];
  });
}

function emitIfPermission(sessionId: string, live: LiveQuery, pending: PendingUserInput): void {
  if (pending.kind === 'permission') {
    sseEvents.emitPermissionRequests(sessionId, permissionRequestsOf(live));
  }
}

/**
 * Park a tool call until the user answers it ({@link answerUserInput}) or the CLI
 * gives up on it (`signal`), and flag the session for the user.
 */
export function parkUserInput(
  sessionId: string,
  live: LiveQuery,
  request: UserInputRequest,
  signal: AbortSignal
): Promise<PermissionResult> {
  return new Promise<PermissionResult>((resolve, reject) => {
    if (signal.aborted) return reject(new Error('Tool call aborted'));
    const pending: PendingUserInput = { ...request, resolve, reject };
    live.pendingInputs.set(request.toolUseId, pending);
    signal.addEventListener(
      'abort',
      () =>
        takeUserInput(sessionId, live, request.toolUseId)?.reject(new Error('Tool call aborted')),
      { once: true }
    );
    emitIfPermission(sessionId, live, pending);

    const summary =
      request.kind === 'permission'
        ? permissionAttentionSummary(request)
        : interactiveToolAttentionSummary(request.toolName, request.input);
    if (summary) {
      requestAttention(sessionId, summary).catch((err) =>
        log.error('Failed to flag session for attention', toError(err), { sessionId })
      );
    }
  });
}

/** Remove a parked tool call so the caller can settle it; null if it isn't parked. */
function takeUserInput(
  sessionId: string,
  live: LiveQuery,
  toolUseId: string
): PendingUserInput | null {
  const pending = live.pendingInputs.get(toolUseId);
  if (!pending) return null;
  live.pendingInputs.delete(toolUseId);
  emitIfPermission(sessionId, live, pending);
  return pending;
}

/** The user's answer to a parked tool call, by the kind of call it answers. */
export type UserInputAnswer =
  | { kind: 'interactive'; response: ToolResponse }
  | { kind: 'permission'; allow: boolean; feedback?: string };

/** Translate a user's answer into the SDK PermissionResult the parked call resolves to. */
function answerResult(answer: UserInputAnswer, input: Record<string, unknown>): PermissionResult {
  if (answer.kind === 'permission') {
    return answer.allow
      ? { behavior: 'allow', updatedInput: input }
      : { behavior: 'deny', message: answer.feedback?.trim() || PERMISSION_DENIED_MESSAGE };
  }
  const { response } = answer;
  if (response.kind === 'questions') {
    return {
      behavior: 'allow',
      updatedInput: { questions: input.questions, answers: response.answers },
    };
  }
  if (response.approve) return { behavior: 'allow', updatedInput: input };
  return {
    behavior: 'deny',
    message:
      response.feedback?.trim() || 'User rejected the plan. Please revise it before proceeding.',
  };
}

/**
 * Settle a parked tool call of the answer's kind with the user's answer, and
 * record the interaction. Returns false if no such call is parked.
 */
export async function answerUserInput(
  sessionId: string,
  live: LiveQuery | null,
  toolUseId: string,
  answer: UserInputAnswer
): Promise<boolean> {
  if (!live || live.pendingInputs.get(toolUseId)?.kind !== answer.kind) return false;
  const pending = takeUserInput(sessionId, live, toolUseId);
  if (!pending) return false;
  log.info('Answered parked tool call', {
    sessionId,
    toolName: pending.toolName,
    kind: answer.kind,
  });
  pending.resolve(answerResult(answer, pending.input));
  await bumpSessionActivity(sessionId);
  return true;
}

/** Reject every parked tool call of a query that is going away. */
export function rejectAllUserInput(sessionId: string, live: LiveQuery, reason: string): void {
  for (const toolUseId of [...live.pendingInputs.keys()]) {
    takeUserInput(sessionId, live, toolUseId)?.reject(new Error(reason));
  }
}
