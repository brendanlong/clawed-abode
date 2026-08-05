import { useCallback } from 'react';
import { trpc } from '@/lib/trpc';
import { taskHasEndState } from '@/lib/session-status';
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

  // Fetch the ids of messages the SDK has accepted but not yet handed to the
  // agent. Seeded once and kept current by the SSE `pending` channel (staleTime
  // Infinity so a focus refetch can't clobber the live value).
  const { data: pendingData, refetch: refetchPending } = trpc.claude.getPendingMessageIds.useQuery(
    { sessionId },
    { staleTime: Infinity }
  );

  // Refetch when app regains visibility or network reconnects
  const refetchAll = useCallback(() => {
    refetch();
    refetchCommands();
    refetchRetry();
    refetchBackground();
    refetchPending();
  }, [refetch, refetchCommands, refetchRetry, refetchBackground, refetchPending]);
  useRefetchOnReconnect(refetchAll);

  // Live running-state and command updates arrive via the multiplexed SSE stream
  // (useSessionStream), which writes directly into these query caches.

  const sendMutation = trpc.claude.send.useMutation();
  const interruptMutation = trpc.claude.interrupt.useMutation();
  const answerMutation = trpc.claude.answerQuestion.useMutation();
  const respondToPlanMutation = trpc.claude.respondToPlan.useMutation();
  const stopBackgroundTaskMutation = trpc.claude.stopBackgroundTask.useMutation();

  // Returns a promise that rejects if the send fails (e.g. a network blip, or the
  // session no longer running), so the composer can restore the just-typed text
  // instead of losing it to the optimistic clear.
  const send = useCallback(
    (prompt: string, attachments?: string[]) => {
      return sendMutation.mutateAsync({ sessionId, prompt, attachments });
    },
    [sessionId, sendMutation]
  );

  // Stop the current turn. Resolves with any prompts the server pulled back
  // because the agent hadn't read them yet, so the caller can restore them.
  const interrupt = useCallback(() => {
    return interruptMutation.mutateAsync({ sessionId });
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
  const pendingMessageIds = pendingData?.messageIds ?? [];

  return {
    isRunning,
    retry,
    backgroundTasks,
    // Only tasks with a knowable end state gate the background-vs-waiting status;
    // a permanently-backgrounded Bash daemon (dev server) shouldn't read as "busy".
    backgroundActive: backgroundTasks.some(taskHasEndState),
    pendingMessageIds,
    send,
    interrupt,
    isInterrupting: interruptMutation.isPending,
    answerQuestion,
    respondToPlan,
    stopBackgroundTask,
    commands,
  };
}
