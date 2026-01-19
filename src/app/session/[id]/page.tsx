'use client';

import { skipToken } from '@tanstack/react-query';
import { useState, useCallback, useMemo, useEffect, use } from 'react';
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

  // Stable cursor for subscription - set once when history first loads, never changes after
  const [subscriptionCursor, setSubscriptionCursor] = useState<number | null>(null);

  // Set subscription cursor once when history first loads (intentional one-time state update)
  useEffect(() => {
    if (subscriptionCursor !== null || historyLoading) {
      return; // Already set or still loading
    }
    const firstPage = historyData?.pages?.[0];
    if (firstPage && firstPage.messages.length > 0) {
      // eslint-disable-next-line react-hooks/set-state-in-effect -- intentional one-time initialization
      setSubscriptionCursor(Math.max(...firstPage.messages.map((m) => m.sequence)));
    } else {
      setSubscriptionCursor(-1); // No messages, start from beginning
    }
  }, [subscriptionCursor, historyLoading, historyData?.pages]);

  // Local state for messages received via subscription
  const [newMessages, setNewMessages] = useState<Message[]>([]);

  // Subscribe to new messages
  trpc.claude.subscribe.useSubscription(
    subscriptionCursor !== null ? { sessionId, afterCursor: subscriptionCursor } : skipToken,
    {
      onData: (message) => {
        setNewMessages((prev) => {
          if (prev.some((m) => m.id === message.id)) return prev;
          return [
            ...prev,
            {
              id: message.id,
              type: message.type,
              content: message.content,
              sequence: message.sequence,
            },
          ];
        });
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

  // Merge history + new messages from subscription, with deduplication
  const allMessages = useMemo(() => {
    const fromHistory: Message[] = [];
    if (historyData?.pages) {
      // Pages are in reverse order (newest page first), but messages within each page are chronological
      // We need to reverse pages to get oldest-first, then flatten
      for (const page of [...historyData.pages].reverse()) {
        for (const msg of page.messages) {
          fromHistory.push({
            id: msg.id,
            type: msg.type,
            content: msg.content,
            sequence: msg.sequence,
          });
        }
      }
    }

    // Filter out any new messages that already appear in history
    const historyIds = new Set(fromHistory.map((m) => m.id));
    const uniqueNew = newMessages.filter((m) => !historyIds.has(m.id));

    return [...fromHistory, ...uniqueNew];
  }, [historyData, newMessages]);

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
