import { toAttentionSummary } from './session-attention';

/**
 * A tool call the permission mode wouldn't decide on its own, parked until the
 * user allows or denies it (doc/claude-sessions.md "Permission Requests").
 */
export interface PermissionRequest {
  toolUseId: string;
  toolName: string;
  input: Record<string, unknown>;
  /** The CLI's prompt sentence, e.g. "Claude wants to read foo.txt". */
  title: string | null;
  description: string | null;
  /** Why it escalated, e.g. the auto-mode classifier's reasoning. */
  reason: string | null;
  /** The subagent that made the call, or null for the main agent. */
  agentId: string | null;
}

export const PERMISSION_DENIED_MESSAGE = 'The user denied permission for this tool call.';

export function permissionRequestTitle(request: PermissionRequest): string {
  return request.title ?? `Claude wants to use ${request.toolName}`;
}

export function permissionAttentionSummary(request: PermissionRequest): string {
  return toAttentionSummary(
    `Permission needed: ${permissionRequestTitle(request)}`,
    'Claude needs permission'
  );
}

/** The part of a tool call's input worth showing in a permission prompt. */
export function permissionInputPreview(input: Record<string, unknown>): string {
  for (const key of ['command', 'file_path', 'path', 'url']) {
    const value = input[key];
    if (typeof value === 'string' && value.length > 0) return value;
  }
  return JSON.stringify(input, null, 2);
}
