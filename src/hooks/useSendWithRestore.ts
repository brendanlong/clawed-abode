'use client';

import { useCallback, useState } from 'react';
import type { CancelledPrompt } from '@/lib/cancelled-prompt';

export interface SendWithRestoreOptions<D> {
  /** The draft state when the composer holds nothing. */
  empty: D;
  /** Send the draft. A rejection restores it and surfaces the error. */
  send: (draft: D) => void | Promise<unknown>;
  /**
   * Stop the current turn. Resolves with any prompts the server pulled back
   * because the agent hadn't read them yet; their transcript bubbles are already
   * deleted, so the composer is the last copy and must take them back.
   */
  interrupt: () => void | Promise<CancelledPrompt[] | void>;
  /**
   * Merge a failed send back into the current draft. Should leave anything the
   * user has typed since alone: the failed message is still in the transcript, so
   * nothing is lost by skipping the restore.
   */
  restoreFailed: (current: D, failed: D) => D;
  /** Merge recalled prompts into the current draft (recalled text goes first). */
  restoreCancelled: (current: D, cancelled: readonly CancelledPrompt[]) => D;
}

function errorMessage(err: unknown, fallback: string): string {
  return err instanceof Error ? err.message : fallback;
}

/**
 * Composer draft state with optimistic send and restore-on-failure, shared by the
 * text composer and the voice panel so the two can't drift.
 *
 * `submit` clears the draft immediately for snappy input, then sends; if the send
 * rejects (queue overflow, session not running, network blip) the draft is
 * restored via `restoreFailed` and the error surfaced as `sendError`. `stop`
 * interrupts the turn and merges any recalled prompts back via `restoreCancelled`.
 * Pass stable callbacks (module-level functions or `useCallback`) so the returned
 * handlers keep their identity across renders.
 */
export function useSendWithRestore<D>({
  empty,
  send,
  interrupt,
  restoreFailed,
  restoreCancelled,
}: SendWithRestoreOptions<D>) {
  const [draft, setDraft] = useState<D>(empty);
  const [sendError, setSendError] = useState<string | null>(null);

  const submit = useCallback(
    (toSend: D) => {
      setDraft(empty);
      setSendError(null);
      Promise.resolve(send(toSend)).catch((err: unknown) => {
        setDraft((current) => restoreFailed(current, toSend));
        setSendError(errorMessage(err, 'Failed to send message'));
      });
    },
    [empty, send, restoreFailed]
  );

  const stop = useCallback(() => {
    Promise.resolve(interrupt())
      .then((cancelled) => {
        if (!cancelled?.length) return;
        setDraft((current) => restoreCancelled(current, cancelled));
      })
      .catch((err: unknown) => {
        setSendError(errorMessage(err, 'Failed to stop'));
      });
  }, [interrupt, restoreCancelled]);

  const clearSendError = useCallback(() => setSendError(null), []);

  return { draft, setDraft, sendError, clearSendError, submit, stop };
}
