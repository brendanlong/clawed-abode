import { z } from 'zod';
import { SESSION_NAME_MAX_LENGTH } from './types';

/**
 * Single-line, since agents can set names too and a name reaches other agents'
 * prompts (cross-session message labels).
 */
export const sessionNameSchema = z
  .string()
  .trim()
  .min(1)
  .max(SESSION_NAME_MAX_LENGTH)
  .refine((name) => !/[\u0000-\u001f\u007f]/.test(name), {
    message: 'Session name must be a single line',
  });

/** The name a session gets when the user leaves it blank; null `repoFullName` is a no-repo session. */
export function defaultSessionName(repoFullName: string | null, branch: string): string {
  const name = repoFullName ? `${repoFullName.split('/').pop()} - ${branch}` : 'Workspace';
  return name.slice(0, SESSION_NAME_MAX_LENGTH);
}

export function isDefaultSessionName(session: {
  name: string;
  repoFullName: string | null;
  branch: string | null;
}): boolean {
  return session.name === defaultSessionName(session.repoFullName, session.branch ?? '');
}
