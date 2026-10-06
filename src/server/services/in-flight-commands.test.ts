import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Query } from '@anthropic-ai/claude-agent-sdk';
import type { InFlightCommand } from '@/lib/live-turn';
import { cancelUnstartedCommands, discardUnreadPrompts } from './in-flight-commands';

const mockResolveUploadPaths = vi.hoisted(() =>
  vi.fn(async (sessionId: string, names: string[]) =>
    names.map((n) => `/ws/${sessionId}/uploads/${n}`)
  )
);
vi.mock('./uploads', () => ({ resolveUploadPaths: mockResolveUploadPaths }));
const mockRemoveMessages = vi.hoisted(() => vi.fn(async () => {}));
vi.mock('./message-store', () => ({ removeMessages: mockRemoveMessages }));

function inFlight(commands: Record<string, { started?: boolean; attachments?: string[] }>) {
  return new Map<string, InFlightCommand>(
    Object.entries(commands).map(([uuid, c]) => [
      uuid,
      {
        messageId: `m-${uuid}`,
        text: uuid,
        attachments: c.attachments ?? [],
        content: uuid,
        started: c.started ?? false,
        resultsSeen: 0,
      },
    ])
  );
}

const queryThat = (cancel: (uuid: string) => Promise<boolean>) =>
  ({ cancelAsyncMessage: vi.fn(cancel) }) as unknown as Query & {
    cancelAsyncMessage: ReturnType<typeof vi.fn>;
  };

beforeEach(() => vi.clearAllMocks());

describe('cancelUnstartedCommands', () => {
  it('asks the CLI to drop only unread commands, returning those it dropped in push order', async () => {
    const query = queryThat(async (uuid) => uuid !== 'dequeued');
    const reported: string[] = [];
    const dropped = await cancelUnstartedCommands(
      's',
      inFlight({ a: {}, read: { started: true }, dequeued: {}, b: {} }),
      query,
      (uuid) => reported.push(uuid)
    );
    expect(dropped.map((c) => c.messageId)).toEqual(['m-a', 'm-b']);
    expect(reported).toEqual(['a', 'b']);
    expect(query.cancelAsyncMessage.mock.calls.map(([uuid]) => uuid)).toEqual([
      'a',
      'dequeued',
      'b',
    ]);
  });

  it('reports each drop as soon as it is confirmed, before the next cancel', async () => {
    const reported: string[] = [];
    const query = queryThat(async (uuid) => {
      if (uuid === 'b') expect(reported).toEqual(['a']);
      return true;
    });
    await cancelUnstartedCommands('s', inFlight({ a: {}, b: {} }), query, (uuid) =>
      reported.push(uuid)
    );
    expect(reported).toEqual(['a', 'b']);
  });

  it('treats a failed cancel as not dropped', async () => {
    const query = queryThat(async () => {
      throw new Error('control channel closed');
    });
    const onDropped = vi.fn();
    expect(await cancelUnstartedCommands('s', inFlight({ a: {} }), query, onDropped)).toEqual([]);
    expect(onDropped).not.toHaveBeenCalled();
  });
});

describe('discardUnreadPrompts', () => {
  it('deletes the bubbles and returns text + attachments for the composer', async () => {
    const [[, command]] = inFlight({ unread: { attachments: ['0123abcd-notes.txt'] } });
    expect(await discardUnreadPrompts('s', [command])).toEqual([
      {
        text: 'unread',
        attachments: [
          {
            name: 'notes.txt',
            storedName: '0123abcd-notes.txt',
            path: '/ws/s/uploads/0123abcd-notes.txt',
          },
        ],
      },
    ]);
    expect(mockRemoveMessages).toHaveBeenCalledWith('s', ['m-unread']);
  });

  it('discarding nothing touches nothing', async () => {
    expect(await discardUnreadPrompts('s', [])).toEqual([]);
    expect(mockRemoveMessages).not.toHaveBeenCalled();
  });
});
