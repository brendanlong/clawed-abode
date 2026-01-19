'use client';

import { useState, useCallback, useMemo, use } from 'react';
import Link from 'next/link';
import { AuthGuard } from '@/components/AuthGuard';
import { Header } from '@/components/Header';
import { MessageList } from '@/components/MessageList';
import { PromptInput } from '@/components/PromptInput';
import { trpc } from '@/lib/trpc';

interface Message {
  id: string;
  type: string;
  content: unknown;
  sequence: number;
}

function SessionHeader({
  session,
  onStart,
  onStop,
  isStarting,
  isStopping,
}: {
  session: {
    id: string;
    name: string;
    repoUrl: string;
    branch: string;
    status: string;
  };
  onStart: () => void;
  onStop: () => void;
  isStarting: boolean;
  isStopping: boolean;
}) {
  const repoName = session.repoUrl.replace('https://github.com/', '').replace('.git', '');

  const statusColors: Record<string, string> = {
    running: 'bg-green-100 text-green-800',
    stopped: 'bg-gray-100 text-gray-800',
    creating: 'bg-yellow-100 text-yellow-800',
    error: 'bg-red-100 text-red-800',
  };

  return (
    <div className="border-b bg-white px-4 py-3">
      <div className="flex items-center justify-between">
        <div className="flex items-center space-x-4">
          <Link href="/" className="text-gray-400 hover:text-gray-600">
            <svg className="w-6 h-6" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                strokeWidth={2}
                d="M15 19l-7-7 7-7"
              />
            </svg>
          </Link>
          <div>
            <h1 className="font-semibold text-gray-900">{session.name}</h1>
            <p className="text-sm text-gray-500">
              {repoName} • {session.branch}
            </p>
          </div>
        </div>

        <div className="flex items-center space-x-3">
          <span
            className={`inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-medium ${
              statusColors[session.status] || statusColors.stopped
            }`}
          >
            {session.status}
          </span>

          {session.status === 'stopped' && (
            <button
              onClick={onStart}
              disabled={isStarting}
              className="px-3 py-1 text-sm bg-green-600 text-white rounded hover:bg-green-700 disabled:opacity-50"
            >
              {isStarting ? 'Starting...' : 'Start'}
            </button>
          )}
          {session.status === 'running' && (
            <button
              onClick={onStop}
              disabled={isStopping}
              className="px-3 py-1 text-sm bg-yellow-600 text-white rounded hover:bg-yellow-700 disabled:opacity-50"
            >
              {isStopping ? 'Stopping...' : 'Stop'}
            </button>
          )}
        </div>
      </div>
    </div>
  );
}

function SessionView({ sessionId }: { sessionId: string }) {
  // Live messages from subscription
  const [liveMessages, setLiveMessages] = useState<Message[]>([]);
  // Track subscription cursor (updated as messages arrive)
  const [subscriptionCursor, setSubscriptionCursor] = useState<number | null>(null);

  // Fetch session details
  const {
    data: sessionData,
    isLoading: sessionLoading,
    refetch: refetchSession,
  } = trpc.sessions.get.useQuery({ sessionId });

  // Infinite query for message history (paginating backwards)
  const {
    data: historyData,
    isLoading: historyLoading,
    isFetchingNextPage,
    hasNextPage,
    fetchNextPage,
  } = trpc.claude.getHistory.useInfiniteQuery(
    { sessionId, limit: 50 },
    {
      getNextPageParam: (lastPage) => (lastPage.hasMore ? lastPage.nextCursor : undefined),
    }
  );

  // Check if Claude is running
  const { data: runningData } = trpc.claude.isRunning.useQuery(
    { sessionId },
    { refetchInterval: 2000 }
  );

  // Extract messages from infinite query pages
  const historyMessages = useMemo(() => {
    if (!historyData?.pages) return [];
    const allMessages: Message[] = [];
    for (const page of historyData.pages) {
      for (const msg of page.messages) {
        allMessages.push({
          id: msg.id,
          type: msg.type,
          content: msg.content,
          sequence: msg.sequence,
        });
      }
    }
    return allMessages;
  }, [historyData]);

  // Compute initial subscription sequence from history (no effect needed)
  const initialSubscriptionSequence = useMemo(() => {
    if (historyLoading) return null;
    if (historyMessages.length > 0) {
      return Math.max(...historyMessages.map((m) => m.sequence));
    }
    return -1; // No messages, start from beginning
  }, [historyMessages, historyLoading]);

  // Effective cursor: use live cursor if available, otherwise initial from history
  const effectiveCursor = subscriptionCursor ?? initialSubscriptionSequence;

  // Subscribe to new messages
  trpc.claude.subscribe.useSubscription(
    { sessionId, afterSequence: effectiveCursor ?? undefined },
    {
      enabled: effectiveCursor !== null,
      onData: (message) => {
        setLiveMessages((prev) => {
          if (prev.some((m) => m.id === message.id)) return prev;
          return [...prev, message];
        });
        setSubscriptionCursor(message.sequence);
      },
      onError: (err) => {
        console.error('Subscription error:', err);
      },
    }
  );

  // Mutations
  const startMutation = trpc.sessions.start.useMutation({
    onSuccess: () => refetchSession(),
  });

  const stopMutation = trpc.sessions.stop.useMutation({
    onSuccess: () => refetchSession(),
  });

  const interruptMutation = trpc.claude.interrupt.useMutation();
  const sendMutation = trpc.claude.send.useMutation();

  // Merge history + live messages, sorted by sequence, deduplicated
  const allMessages = useMemo(() => {
    const combined = [...historyMessages, ...liveMessages];
    const seen = new Set<string>();
    const deduped = combined.filter((msg) => {
      if (seen.has(msg.id)) return false;
      seen.add(msg.id);
      return true;
    });
    return deduped.sort((a, b) => a.sequence - b.sequence);
  }, [historyMessages, liveMessages]);

  const handleSendPrompt = useCallback(
    (prompt: string) => {
      if (!sessionData?.session || sessionData.session.status !== 'running') {
        return;
      }
      sendMutation.mutate({ sessionId, prompt });
    },
    [sessionId, sessionData, sendMutation]
  );

  const handleInterrupt = useCallback(() => {
    interruptMutation.mutate({ sessionId });
  }, [sessionId, interruptMutation]);

  const handleLoadMore = useCallback(() => {
    if (hasNextPage && !isFetchingNextPage) {
      fetchNextPage();
    }
  }, [hasNextPage, isFetchingNextPage, fetchNextPage]);

  if (sessionLoading) {
    return (
      <div className="flex-1 flex items-center justify-center">
        <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-blue-600"></div>
      </div>
    );
  }

  if (!sessionData?.session) {
    return (
      <div className="flex-1 flex flex-col items-center justify-center">
        <p className="text-gray-500">Session not found</p>
        <Link href="/" className="mt-4 text-blue-600 hover:underline">
          Back to sessions
        </Link>
      </div>
    );
  }

  const session = sessionData.session;
  const isClaudeRunning = runningData?.running ?? false;

  return (
    <div className="flex-1 flex flex-col">
      <SessionHeader
        session={session}
        onStart={() => startMutation.mutate({ sessionId })}
        onStop={() => stopMutation.mutate({ sessionId })}
        isStarting={startMutation.isPending}
        isStopping={stopMutation.isPending}
      />

      <MessageList
        messages={allMessages}
        isLoading={historyLoading || isFetchingNextPage}
        hasMore={hasNextPage ?? false}
        onLoadMore={handleLoadMore}
      />

      <PromptInput
        onSubmit={handleSendPrompt}
        onInterrupt={handleInterrupt}
        isRunning={isClaudeRunning}
        disabled={session.status !== 'running'}
      />
    </div>
  );
}

export default function SessionPage({ params }: { params: Promise<{ id: string }> }) {
  const resolvedParams = use(params);

  return (
    <AuthGuard>
      <div className="min-h-screen bg-gray-50 flex flex-col">
        <Header />
        <SessionView sessionId={resolvedParams.id} />
      </div>
    </AuthGuard>
  );
}
