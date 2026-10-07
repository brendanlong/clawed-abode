/**
 * Pure helpers for the app-level notifier, which raises a desktop notification
 * whenever an agent asks for the user (an `attention` list event) — unless the
 * user is already watching that session: its page on screen *and* the tab visible.
 */

/**
 * Extract the session id from a session-view pathname (`/session/{id}`), or null
 * for any other route. Used to decide which session (if any) is on screen.
 */
export function parseViewedSessionId(pathname: string | null | undefined): string | null {
  if (!pathname) return null;
  const match = pathname.match(/^\/session\/([^/?#]+)/);
  return match ? match[1] : null;
}

export function isActivelyWatching({
  sessionId,
  viewedSessionId,
  tabHidden,
}: {
  sessionId: string;
  /** The session whose page is on screen (null if none). */
  viewedSessionId: string | null;
  tabHidden: boolean;
}): boolean {
  return sessionId === viewedSessionId && !tabHidden;
}
