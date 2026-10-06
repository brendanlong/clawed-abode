import { basename } from 'path';
import type { Query } from '@anthropic-ai/claude-agent-sdk';
import { displayFileName, type UploadedAttachment } from '@/lib/attachments';
import type { CancelledPrompt } from '@/lib/cancelled-prompt';
import type { InFlightCommand } from '@/lib/live-turn';
import { createLogger, toError } from '@/lib/logger';
import { removeMessages } from './message-store';
import { resolveUploadPaths } from './uploads';

const log = createLogger('in-flight-commands');

/**
 * The side-effecting half of delivery tracking for pushed user messages: taking
 * back what the CLI hasn't read, and disposing of taken-back prompts. The tracking
 * itself is the pure reducer in src/lib/live-turn.ts. Rationale (why Stop cancels
 * before interrupting): doc/claude-sessions.md, "Sends Are Immediate".
 */

/** `Query.cancelAsyncMessage` exists at runtime but is missing from the SDK's `Query` type. */
type CancelCapableQuery = Query & {
  cancelAsyncMessage(messageUuid: string): Promise<boolean>;
};

/**
 * Ask the CLI to drop every pushed message the agent hasn't read yet, returning
 * those it dropped, in push order, by command uuid. The caller records the recall
 * and disposes of the prompts — the two callers disagree about the bubbles (Stop
 * deletes them, a rate-limit pause keeps them and re-queues).
 *
 * Must run **before** `interrupt()`: the abort wakes the CLI's drain loop, which
 * starts the next queued command immediately (see doc/claude-sessions.md).
 */
export async function cancelUnstartedCommands(
  sessionId: string,
  inFlight: ReadonlyMap<string, InFlightCommand>,
  query: Query
): Promise<[string, InFlightCommand][]> {
  const recallable = [...inFlight].filter(([, c]) => !c.started);
  const canceller = query as CancelCapableQuery;

  const dropped: [string, InFlightCommand][] = [];
  for (const entry of recallable) {
    try {
      // false = the CLI already dequeued it; the agent did read it, so it stays put.
      if (await canceller.cancelAsyncMessage(entry[0])) dropped.push(entry);
    } catch (err) {
      log.warn('cancelUnstartedCommands: cancelAsyncMessage failed', {
        sessionId,
        error: toError(err).message,
      });
    }
  }
  return dropped;
}

/**
 * Take back prompts the agent never read (recalled from the CLI, or parked behind
 * a rate-limit pause) for Stop: they never happened, so their bubbles are deleted
 * and the text/attachments handed back for the composer to restore.
 */
export async function discardUnreadPrompts(
  sessionId: string,
  prompts: { messageId: string; text: string; attachments: string[] }[]
): Promise<CancelledPrompt[]> {
  if (prompts.length === 0) return [];
  await removeMessages(
    sessionId,
    prompts.map((prompt) => prompt.messageId)
  );
  return Promise.all(
    prompts.map(async (prompt) => ({
      text: prompt.text,
      attachments: await describeAttachments(sessionId, prompt.attachments),
    }))
  );
}

/**
 * Rebuild composer-ready attachment records from stored names (the display name
 * is recovered the way the chips do it; files already gone from disk are dropped).
 */
async function describeAttachments(
  sessionId: string,
  storedNames: string[]
): Promise<UploadedAttachment[]> {
  if (storedNames.length === 0) return [];
  const paths = await resolveUploadPaths(sessionId, storedNames);
  return paths.map((filePath) => {
    const storedName = basename(filePath);
    return { name: displayFileName(storedName), storedName, path: filePath };
  });
}
