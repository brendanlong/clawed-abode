import type { PermissionResult } from '@anthropic-ai/claude-agent-sdk';
import { createLogger, toError } from '@/lib/logger';
import { permissionAttentionSummary, type PermissionRequest } from '@/lib/permission-request';
import { interactiveToolAttentionSummary } from '@/lib/session-attention';
import { sseEvents } from './events';
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
 * Park a tool call until the user answers it ({@link takeUserInput}) or the CLI
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
export function takeUserInput(
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

/** Reject every parked tool call of a query that is going away. */
export function rejectAllUserInput(sessionId: string, live: LiveQuery, reason: string): void {
  for (const toolUseId of [...live.pendingInputs.keys()]) {
    takeUserInput(sessionId, live, toolUseId)?.reject(new Error(reason));
  }
}
