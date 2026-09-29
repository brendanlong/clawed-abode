import { useCallback } from 'react';
import { trpc } from '@/lib/trpc';
import { taskHasEndState } from '@/lib/session-status';
import { LIVE_QUERY_OPTIONS } from '@/lib/live-query';

/**
 * Hook for managing Claude process state: running status, send prompts, interrupt, and commands.
 *
 * The live state is seeded by one query and then kept current by the multiplexed
 * SSE stream (useSessionStream), which patches fields of its cache directly; see
 * LIVE_QUERY_OPTIONS for the focus/reconnect resync policy.
 */
export function useClaudeState(sessionId: string) {
  const { data: live } = trpc.claude.getLiveState.useQuery({ sessionId }, LIVE_QUERY_OPTIONS);

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
  const isRunning = live?.running ?? false;
  // Running background tasks. These never gate input — indicator only.
  const backgroundTasks = live?.backgroundTasks ?? [];

  return {
    isRunning,
    // Ephemeral API-retry status (rate limit / overload).
    retry: live?.retry ?? null,
    backgroundTasks,
    // Only tasks with a knowable end state gate the background-vs-waiting status;
    // a permanently-backgrounded Bash daemon (dev server) shouldn't read as "busy".
    backgroundActive: backgroundTasks.some(taskHasEndState),
    // Ids of messages the SDK has accepted but not yet handed to the agent.
    pendingMessageIds: live?.pendingMessageIds ?? [],
    // Prompts held back by a subscription rate-limit pause.
    queuedMessageIds: live?.queuedMessageIds ?? [],
    // The session's subscription rate-limit pause, or null. Sends still succeed
    // while paused — the server queues them — so this never gates the composer.
    rateLimitHold: live?.rateLimitHold ?? null,
    send,
    interrupt,
    isInterrupting: interruptMutation.isPending,
    answerQuestion,
    respondToPlan,
    stopBackgroundTask,
    commands: live?.commands ?? [],
  };
}
