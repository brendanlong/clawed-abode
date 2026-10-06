import { z } from 'zod';

/**
 * Guards the automatic login ↔ public files redirect. If the browser won't keep
 * the public cookie (cookies blocked, or an http PUBLIC_FILES_URL dropping the
 * Secure cookie), every pass would bounce straight back here and mint another
 * session, forever.
 */
const STORAGE_KEY = 'publicLoginAttempt';
export const PUBLIC_LOGIN_RETRY_WINDOW_MS = 30 * 1000;

const attemptSchema = z.object({ next: z.string(), at: z.number() });
type Attempt = z.infer<typeof attemptSchema>;

export function isRepeatAttempt(last: Attempt | null, next: string, now: number): boolean {
  return last !== null && last.next === next && now - last.at < PUBLIC_LOGIN_RETRY_WINDOW_MS;
}

/** Records an automatic return to `next`; false if one just happened, so the caller should stop. */
export function claimAutomaticReturn(storage: Storage, next: string, now = Date.now()): boolean {
  let last: Attempt | null = null;
  try {
    last = attemptSchema.parse(JSON.parse(storage.getItem(STORAGE_KEY) ?? 'null'));
  } catch {
    // Missing or corrupt: treat as no previous attempt.
  }
  if (isRepeatAttempt(last, next, now)) return false;
  storage.setItem(STORAGE_KEY, JSON.stringify({ next, at: now }));
  return true;
}

/** Forget the last attempt, when it failed before reaching the public files server. */
export function releaseAutomaticReturn(storage: Storage): void {
  storage.removeItem(STORAGE_KEY);
}
