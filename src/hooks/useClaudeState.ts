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

  // Subscribe to Claude running state via SSE - update cache directly
  trpc.sse.onClaudeRunning.useSubscription(
    { sessionId },
    {
      onData: (trackedData) => {
        utils.claude.isRunning.setData({ sessionId }, { running: trackedData.data.running });
        // When Claude finishes running, refetch commands in case new ones were discovered
        if (!trackedData.data.running) {
          refetchCommands();
          // The retry banner is meaningless once the turn ends.
          setRetryStatus(null);
        }
      },
      onError: (err) => {
        console.error('Claude running SSE error:', err);
      },
    }
  );

  // Subscribe to ephemeral rate-limit retry status via SSE
  trpc.sse.onRetryStatus.useSubscription(
    { sessionId },
    {
      onData: (trackedData) => {
        setRetryStatus(trackedData.data.retry);
      },
      onError: (err) => {
        console.error('Retry status SSE error:', err);
      },
    }
  );

  // Subscribe to commands updates via SSE - update cache directly
  trpc.sse.onCommands.useSubscription(
    { sessionId },
    {
      onData: (trackedData) => {
        utils.claude.getCommands.setData({ sessionId }, { commands: trackedData.data.commands });
      },
      onError: (err) => {
        console.error('Commands SSE error:', err);
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
