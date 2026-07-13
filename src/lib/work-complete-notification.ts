/**
 * Pure helpers for the app-level "Claude finished" notifier.
 *
 * The notifier watches the global session-list stream and fires a desktop
 * notification whenever *any* session that isn't currently being watched
 * transitions from working (a main-agent turn active) to idle. "Being watched"
 * means its page is on screen *and* the browser tab is visible — a session you
 * are actively looking at shouldn't notify; every other session should.
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
 * Decide whether a running-state change should raise a work-complete
 * notification. Fires only on a genuine working → idle transition (so we need a
 * prior `true`, not `undefined`), and never for the session the user is actively
 * watching.
 *
 * @param wasRunning  the session's previous turn-active state (undefined if unseen)
 * @param nowRunning  the session's new turn-active state
 * @param isWatching  the session is on screen and the tab is visible
 */
export function shouldNotifyOnRunningChange({
  wasRunning,
  nowRunning,
  isWatching,
}: {
  wasRunning: boolean | undefined;
  nowRunning: boolean;
  isWatching: boolean;
}): boolean {
  return wasRunning === true && nowRunning === false && !isWatching;
}
