/**
 * Pure helpers for the app-level "Claude finished" notifier.
 *
 * The notifier watches the global session-list stream for `finished` events (a
 * main-agent turn ending *naturally* — the server excludes interrupt/stop/error,
 * see `emitClaudeFinished`) and raises a desktop notification for any session that
 * isn't currently being watched. "Being watched" means its page is on screen *and*
 * the browser tab is visible — a session you are actively looking at shouldn't
 * notify; every other session should.
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

/**
 * Whether the user is actively watching the session that just finished — i.e. its
 * page is the one on screen and the tab is visible. Such a finish is suppressed;
 * every other session notifies.
 *
 * @param finishedSessionId  the session whose turn just ended
 * @param viewedSessionId    the session whose page is on screen (null if none)
 * @param tabHidden          whether the browser tab is currently hidden
 */
export function isActivelyWatching({
  finishedSessionId,
  viewedSessionId,
  tabHidden,
}: {
  finishedSessionId: string;
  viewedSessionId: string | null;
  tabHidden: boolean;
}): boolean {
  return finishedSessionId === viewedSessionId && !tabHidden;
}
