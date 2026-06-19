import { useCallback } from 'react';
import { trpc } from '@/lib/trpc';
import { useRefetchOnReconnect } from './useRefetchOnReconnect';

/**
 * Hook for managing Claude process state: running status, send prompts, interrupt, and commands.
 */
export function useClaudeState(sessionId: string) {
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

  // Live running-state and command updates arrive via the multiplexed SSE stream
  // (useSessionStream), which writes directly into these query caches.

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
    send,
    interrupt,
    isInterrupting: interruptMutation.isPending,
    answerQuestion,
    respondToPlan,
    commands,
  };
}
