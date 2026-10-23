import { afterEach, describe, it, expect, vi } from 'vitest';
import { useState, type ReactNode } from 'react';
import { act, render, renderHook, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { observable } from '@trpc/server/observable';
import { TRPCClientError, type TRPCLink } from '@trpc/client';
import { trpc } from '@/lib/trpc';
import type { AppRouter } from '@/server/routers';
import type { SessionStreamOutput } from '@/server/routers/sse';
import type { ParsedMessage } from '@/server/services/message-store';
import type { Session } from '@/generated/prisma/client';
import { toSessionView } from '@/lib/session-view';
import { buildTokenUsageStats, EMPTY_SESSION_USAGE_TOTALS } from '@/lib/token-estimation';
import { useSessionMessages } from './useSessionMessages';
import { useSessionStream } from './useSessionStream';
import { useTranscriptScroll } from './useTranscriptScroll';

const SESSION_ID = 'a0eebc99-9c0b-4ef8-bb6d-6bb9bd380a11';

type HistoryPage = { messages: ParsedMessage[]; hasMore: boolean };

const message = (id: string, sequence: number): ParsedMessage => ({
  id,
  sessionId: SESSION_ID,
  sequence,
  type: 'user',
  content: { type: 'user', message: { role: 'user', content: id } },
  createdAt: new Date(0),
});

const sessionRow: Session = {
  id: SESSION_ID,
  name: 'Test',
  repoUrl: null,
  branch: null,
  repoPath: '',
  status: 'running',
  statusMessage: null,
  currentBranch: null,
  pullRequestId: null,
  pullRequest: null,
  prCheckedAt: null,
  createdAt: new Date(0),
  updatedAt: new Date(0),
  lastActivityAt: new Date(0),
  messageSequence: 0,
  sessionScope: null,
  claudeModel: null,
  claudeSessionId: null,
  agentName: null,
  sessionToolsEnabled: false,
  attentionAt: null,
  attentionSummary: null,
  rateLimitPauseEnabled: null,
  rateLimitPauseThreshold: null,
  resumeAfterRateLimit: false,
  restartNotice: null,
  queuedPromptSequence: 0,
  usageAlertFiveHour: null,
  usageAlertWeekly: null,
};

function snapshotEvent(messages: ParsedMessage[], hasMore: boolean): SessionStreamOutput {
  return {
    kind: 'snapshot',
    session: toSessionView(sessionRow),
    live: {
      running: false,
      commands: [],
      retry: null,
      backgroundTasks: [],
      pendingMessageIds: [],
      queuedMessageIds: [],
      rateLimitHold: null,
      tokenUsage: buildTokenUsageStats(EMPTY_SESSION_USAGE_TOTALS),
    },
    history: { after: -1, messages, hasMore, partials: [] },
  };
}

/**
 * A tRPC client wired to a fake server: the test pushes session-stream events
 * and answers each `getHistory` request itself, so it controls exactly when an
 * older page lands relative to live events.
 */
function fakeServer() {
  let push: ((event: SessionStreamOutput) => void) | undefined;
  let eventId = 0;
  const historyRequests: {
    cursor: unknown;
    respond: (page: HistoryPage) => void;
    fail: () => void;
  }[] = [];

  const link: TRPCLink<AppRouter> = () => {
    return ({ op }) =>
      observable((observer) => {
        if (op.path === 'sse.onSessionEvents') {
          push = (event) => {
            const id = String(++eventId);
            // What httpSubscriptionLink emits for a `tracked()` event.
            observer.next({ result: { id, data: { id, data: event } } });
          };
          observer.next({ result: { type: 'started' } });
          return () => {
            push = undefined;
          };
        }
        if (op.path === 'claude.getHistory') {
          const { cursor } = op.input as { cursor?: unknown };
          historyRequests.push({
            cursor,
            respond: (page) => {
              observer.next({ result: { type: 'data', data: page } });
              observer.complete();
            },
            fail: () => observer.error(TRPCClientError.from(new Error('history unavailable'))),
          });
          return () => {};
        }
        observer.error(TRPCClientError.from(new Error(`unexpected request: ${op.path}`)));
        return () => {};
      });
  };
  const client = trpc.createClient({ links: [link] });

  function Wrapper({ children }: { children: ReactNode }) {
    const [queryClient] = useState(
      () => new QueryClient({ defaultOptions: { queries: { retry: false } } })
    );
    return (
      <trpc.Provider client={client} queryClient={queryClient}>
        <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
      </trpc.Provider>
    );
  }

  return {
    Wrapper,
    historyRequests,
    isStreamOpen: () => push !== undefined,
    emit(event: SessionStreamOutput) {
      if (!push) throw new Error('session stream is not open');
      push(event);
    },
  };
}

function renderSession() {
  const server = fakeServer();
  const { result } = renderHook(
    () => {
      useSessionStream(SESSION_ID);
      return useSessionMessages(SESSION_ID);
    },
    { wrapper: server.Wrapper }
  );
  return { server, result };
}

const ids = (messages: { id: string }[]) => messages.map((m) => m.id);

describe('useSessionMessages with the session stream', () => {
  it('keeps a live message that arrives while an older page is loading', async () => {
    const { server, result } = renderSession();
    await waitFor(() => expect(server.isStreamOpen()).toBe(true));
    act(() => server.emit(snapshotEvent([message('c', 10), message('d', 11)], true)));
    await waitFor(() => expect(ids(result.current.messages)).toEqual(['c', 'd']));

    act(() => void result.current.fetchMore());
    await waitFor(() => expect(server.historyRequests).toHaveLength(1));
    expect(server.historyRequests[0].cursor).toBe(10);

    act(() => server.emit({ kind: 'message', message: message('e', 12) }));
    await waitFor(() => expect(ids(result.current.messages)).toEqual(['c', 'd', 'e']));

    await act(async () =>
      server.historyRequests[0].respond({
        messages: [message('a', 8), message('b', 9)],
        hasMore: false,
      })
    );
    await waitFor(() => expect(result.current.isFetchingMore).toBe(false));
    expect(ids(result.current.messages)).toEqual(['a', 'b', 'c', 'd', 'e']);
    expect(result.current.hasMore).toBe(false);
  });

  it('keeps the loaded message objects when an older page is prepended', async () => {
    const { server, result } = renderSession();
    await waitFor(() => expect(server.isStreamOpen()).toBe(true));
    act(() =>
      server.emit(snapshotEvent([message('c', 10), message('d', 11), message('e', 12)], true))
    );
    await waitFor(() => expect(ids(result.current.messages)).toEqual(['c', 'd', 'e']));
    const loaded = result.current.messages;

    act(() => void result.current.fetchMore());
    await waitFor(() => expect(server.historyRequests).toHaveLength(1));
    await act(async () =>
      server.historyRequests[0].respond({ messages: [message('b', 9)], hasMore: false })
    );
    await waitFor(() => expect(ids(result.current.messages)).toEqual(['b', 'c', 'd', 'e']));

    // The same objects, so their bubbles skip re-rendering (see messageBubblePropsEqual).
    result.current.messages.slice(1).forEach((m, i) => expect(m).toBe(loaded[i]));
  });

  it('keeps a removal that arrives while an older page is loading', async () => {
    const { server, result } = renderSession();
    await waitFor(() => expect(server.isStreamOpen()).toBe(true));
    act(() => server.emit(snapshotEvent([message('c', 10), message('d', 11)], true)));
    await waitFor(() => expect(result.current.hasMore).toBe(true));

    act(() => void result.current.fetchMore());
    await waitFor(() => expect(server.historyRequests).toHaveLength(1));
    act(() => server.emit({ kind: 'message_removed', messageId: 'd' }));
    await waitFor(() => expect(ids(result.current.messages)).toEqual(['c']));

    await act(async () =>
      server.historyRequests[0].respond({ messages: [message('b', 9)], hasMore: true })
    );
    await waitFor(() => expect(ids(result.current.messages)).toEqual(['b', 'c']));
    expect(result.current.hasMore).toBe(true);
  });

  it('drops an older page that no longer joins a snapshot that replaced the cache', async () => {
    const { server, result } = renderSession();
    await waitFor(() => expect(server.isStreamOpen()).toBe(true));
    act(() => server.emit(snapshotEvent([message('c', 10)], true)));
    await waitFor(() => expect(result.current.hasMore).toBe(true));

    act(() => void result.current.fetchMore());
    await waitFor(() => expect(server.historyRequests).toHaveLength(1));
    act(() => server.emit(snapshotEvent([message('x', 90)], true)));
    await waitFor(() => expect(ids(result.current.messages)).toEqual(['x']));

    await act(async () =>
      server.historyRequests[0].respond({ messages: [message('b', 9)], hasMore: true })
    );
    await waitFor(() => expect(result.current.isFetchingMore).toBe(false));
    expect(ids(result.current.messages)).toEqual(['x']);

    // The next scroll-back continues from the new cache.
    act(() => void result.current.fetchMore());
    await waitFor(() => expect(server.historyRequests).toHaveLength(2));
    expect(server.historyRequests[1].cursor).toBe(90);
  });
});

/**
 * An IntersectionObserver the test drives: `setVisible` moves an element in or
 * out of view, notifying its observers, and `observe` delivers an initial entry
 * asynchronously, as the real one does.
 */
class FakeIntersectionObserver {
  static visible = new Map<Element, boolean>();
  static instances = new Set<FakeIntersectionObserver>();
  private targets = new Set<Element>();

  constructor(private callback: IntersectionObserverCallback) {
    FakeIntersectionObserver.instances.add(this);
  }

  static setVisible(target: Element, visible: boolean) {
    FakeIntersectionObserver.visible.set(target, visible);
    for (const observer of FakeIntersectionObserver.instances) {
      if (observer.targets.has(target)) observer.notify(target);
    }
  }

  private notify(target: Element) {
    const entry = {
      target,
      isIntersecting: FakeIntersectionObserver.visible.get(target) ?? false,
    } as IntersectionObserverEntry;
    this.callback([entry], this as unknown as IntersectionObserver);
  }

  observe(target: Element) {
    this.targets.add(target);
    setTimeout(() => {
      if (this.targets.has(target)) this.notify(target);
    }, 0);
  }
  unobserve(target: Element) {
    this.targets.delete(target);
  }
  disconnect() {
    this.targets.clear();
    FakeIntersectionObserver.instances.delete(this);
  }
  takeRecords(): IntersectionObserverEntry[] {
    return [];
  }
}

function Transcript() {
  useSessionStream(SESSION_ID);
  const { messages, isLoading, isFetchingMore, loadFailed, hasMore, fetchMore } =
    useSessionMessages(SESSION_ID);
  const { containerRef, topSentinelRef, bottomRef } = useTranscriptScroll({
    messages,
    hasMore,
    isLoading: isLoading || isFetchingMore,
    loadFailed,
    onLoadMore: fetchMore,
  });
  return (
    <div ref={containerRef}>
      <div ref={topSentinelRef} data-testid="top-sentinel" />
      {messages.map((m) => (
        <div key={m.id}>{m.id}</div>
      ))}
      <div ref={bottomRef} />
    </div>
  );
}

describe('scrolling back through the transcript', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    FakeIntersectionObserver.visible.clear();
    FakeIntersectionObserver.instances.clear();
  });

  it('does not re-request a failed page until the sentinel scrolls into view again', async () => {
    vi.stubGlobal('IntersectionObserver', FakeIntersectionObserver);
    const server = fakeServer();
    const { getByTestId } = render(<Transcript />, { wrapper: server.Wrapper });
    const sentinel = getByTestId('top-sentinel');
    // A short transcript: the top sentinel stays in view at the bottom.
    FakeIntersectionObserver.visible.set(sentinel, true);

    await waitFor(() => expect(server.isStreamOpen()).toBe(true));
    act(() => server.emit(snapshotEvent([message('c', 10)], true)));
    await waitFor(() => expect(server.historyRequests).toHaveLength(1));
    expect(server.historyRequests[0].cursor).toBe(10);

    await act(async () => server.historyRequests[0].fail());
    // Give any re-observation time to deliver its entry.
    await act(() => new Promise((resolve) => setTimeout(resolve, 50)));
    expect(server.historyRequests).toHaveLength(1);

    // The user scrolls away and back: a real intersection retries.
    act(() => FakeIntersectionObserver.setVisible(sentinel, false));
    act(() => FakeIntersectionObserver.setVisible(sentinel, true));
    await waitFor(() => expect(server.historyRequests).toHaveLength(2));
    expect(server.historyRequests[1].cursor).toBe(10);

    // A short page that leaves the sentinel in view keeps loading.
    await act(async () =>
      server.historyRequests[1].respond({ messages: [message('b', 9)], hasMore: true })
    );
    await waitFor(() => expect(server.historyRequests).toHaveLength(3));
    expect(server.historyRequests[2].cursor).toBe(9);
  });
});
