import { useCallback, useState } from 'react';
import { trpc } from '@/lib/trpc';
import type { ApiRetryStatus } from '@/lib/claude-messages';
import { useRefetchOnReconnect } from './useRefetchOnReconnect';

/**
 * Hook for managing Claude process state: running status, send prompts, interrupt, and commands.
 */
export function useClaudeState(sessionId: string) {
  const utils = trpc.useUtils();

  // Ephemeral rate-limit retry status (not persisted; lives only while retrying)
  const [retryStatus, setRetryStatus] = useState<ApiRetryStatus | null>(null);

  // Fetch Claude running state
  const { data: runningData, refetch } = trpc.claude.isRunning.useQuery({ sessionId });

  // Fetch available slash commands
  const { data: commandsData, refetch: refetchCommands } = trpc.claude.getCommands.useQuery(
    { sessionId },
    { staleTime: Infinity }
  );

  // Refetch when app regains visibility or network reconnects
  const refetchAll = useCallback(() => {
    refetch();
    refetchCommands();
  }, [refetch, refetchCommands]);
  useRefetchOnReconnect(refetchAll);

  // Subscribe to all latest-state events for this session over ONE SSE stream
  // (session updates, running state, retry status, slash commands) and route by
  // type. Consolidating these onto a single subscription keeps the session view
  // from opening a separate connection per signal.
  trpc.sse.onSessionEvents.useSubscription(
    { sessionId },
    {
      onData: (trackedData) => {
        const event = trackedData.data;
        switch (event.type) {
          case 'session_update':
            utils.sessions.get.setData({ sessionId }, { session: event.session });
            break;
          case 'claude_running':
            utils.claude.isRunning.setData({ sessionId }, { running: event.running });
            // When Claude finishes running, refetch commands in case new ones
            // were discovered, and clear the now-meaningless retry banner.
            if (!event.running) {
              refetchCommands();
              setRetryStatus(null);
            }
            break;
          case 'retry_status':
            setRetryStatus(event.retry);
            break;
          case 'commands':
            utils.claude.getCommands.setData({ sessionId }, { commands: event.commands });
            break;
        }
      },
      onError: (err) => {
        console.error('Session events SSE error:', err);
      },
    }
  );

  const sendMutation = trpc.claude.send.useMutation();
  const interruptMutation = trpc.claude.interrupt.useMutation();
  const answerMutation = trpc.claude.answerQuestion.useMutation();
  const respondToPlanMutation = trpc.claude.respondToPlan.useMutation();

  const send = useCallback(
    (prompt: string) => {
      sendMutation.mutate({ sessionId, prompt });
    },
    [sessionId, sendMutation]
  );

  const interrupt = useCallback(() => {
    interruptMutation.mutate({ sessionId });
  }, [sessionId, interruptMutation]);

  const answerQuestion = useCallback(
    (toolUseId: string, answers: Record<string, string>) => {
      answerMutation.mutate({ sessionId, toolUseId, answers });
    },
    [sessionId, answerMutation]
  );

  const respondToPlan = useCallback(
    (toolUseId: string, approve: boolean, feedback?: string) => {
      respondToPlanMutation.mutate({ sessionId, toolUseId, approve, feedback });
    },
    [sessionId, respondToPlanMutation]
  );

  const isRunning = runningData?.running ?? false;
  const commands = commandsData?.commands ?? [];

  return {
    isRunning,
    retryStatus,
    send,
    interrupt,
    isInterrupting: interruptMutation.isPending,
    answerQuestion,
    respondToPlan,
    commands,
  };
}
