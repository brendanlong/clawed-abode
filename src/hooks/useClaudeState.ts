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

  // Fetch ephemeral API-retry status (rate limit / overload). Seeded once and
  // then kept current by the SSE `retry` channel, so staleTime is Infinity to
  // stop a window-focus refetch from clobbering the live value with a stale read.
  const { data: retryData, refetch: refetchRetry } = trpc.claude.getRetryState.useQuery(
    { sessionId },
    { staleTime: Infinity }
  );

  // Fetch running background tasks. Like retry: seeded once and kept current by
  // the SSE `background` channel (staleTime Infinity so a focus refetch can't
  // clobber the live value). These never gate input — indicator only.
  const { data: backgroundData, refetch: refetchBackground } =
    trpc.claude.getBackgroundTasks.useQuery({ sessionId }, { staleTime: Infinity });

  // Refetch when app regains visibility or network reconnects
  const refetchAll = useCallback(() => {
    refetch();
    refetchCommands();
    refetchRetry();
    refetchBackground();
  }, [refetch, refetchCommands, refetchRetry, refetchBackground]);
  useRefetchOnReconnect(refetchAll);

  // Live running-state and command updates arrive via the multiplexed SSE stream
  // (useSessionStream), which writes directly into these query caches.

  const sendMutation = trpc.claude.send.useMutation();
  const interruptMutation = trpc.claude.interrupt.useMutation();
  const answerMutation = trpc.claude.answerQuestion.useMutation();
  const respondToPlanMutation = trpc.claude.respondToPlan.useMutation();
  const stopBackgroundTaskMutation = trpc.claude.stopBackgroundTask.useMutation();

  const send = useCallback(
    (prompt: string, attachments?: string[]) => {
      sendMutation.mutate({ sessionId, prompt, attachments });
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

  const stopBackgroundTask = useCallback(
    (taskId: string) => {
      stopBackgroundTaskMutation.mutate({ sessionId, taskId });
    },
    [sessionId, stopBackgroundTaskMutation]
  );

  // `isRunning` means a main-agent turn is active (gates the composer). Background
  // tasks are tracked separately and never gate input.
  const isRunning = runningData?.running ?? false;
  const commands = commandsData?.commands ?? [];
  const retry = retryData?.retry ?? null;
  const backgroundTasks = backgroundData?.tasks ?? [];

  return {
    isRunning,
    retry,
    backgroundTasks,
    backgroundActive: backgroundTasks.length > 0,
    send,
    interrupt,
    isInterrupting: interruptMutation.isPending,
    answerQuestion,
    respondToPlan,
    stopBackgroundTask,
    commands,
  };
}
