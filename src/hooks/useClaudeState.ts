import { useCallback, useState } from 'react';
import { trpc } from '@/lib/trpc';
import { useRefetchOnReconnect } from './useRefetchOnReconnect';

/**
 * Describes a pending user input request from the SDK's canUseTool callback.
 */
export interface PendingUserInput {
  toolName: string;
  toolUseId: string;
  input: Record<string, unknown>;
}

/**
 * Hook for managing Claude process state: running status, send prompts, interrupt,
 * commands, and user input requests.
 */
export function useClaudeState(sessionId: string) {
  const utils = trpc.useUtils();

  // Track pending user input request (from canUseTool callback)
  const [pendingUserInput, setPendingUserInput] = useState<PendingUserInput | null>(null);

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
        // When Claude finishes running, clear pending input and refetch commands
        if (!trackedData.data.running) {
          setPendingUserInput(null);
          refetchCommands();
        }
      },
      onError: (err) => {
        console.error('Claude running SSE error:', err);
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

  // Subscribe to user input request events (canUseTool waiting for response)
  trpc.sse.onUserInputRequest.useSubscription(
    { sessionId },
    {
      onData: (trackedData) => {
        setPendingUserInput({
          toolName: trackedData.data.toolName,
          toolUseId: trackedData.data.toolUseId,
          input: trackedData.data.input,
        });
      },
      onError: (err) => {
        console.error('User input request SSE error:', err);
      },
    }
  );

  const sendMutation = trpc.claude.send.useMutation();
  const interruptMutation = trpc.claude.interrupt.useMutation();
  const respondMutation = trpc.claude.respondToUserInput.useMutation();

  const send = useCallback(
    (prompt: string) => {
      sendMutation.mutate({ sessionId, prompt });
    },
    [sessionId, sendMutation]
  );

  const interrupt = useCallback(() => {
    interruptMutation.mutate({ sessionId });
  }, [sessionId, interruptMutation]);

  const respondToUserInput = useCallback(
    (
      toolUseId: string,
      response:
        | { behavior: 'allow'; updatedInput?: Record<string, unknown> }
        | { behavior: 'deny'; message?: string }
    ) => {
      setPendingUserInput(null);
      respondMutation.mutate({ sessionId, toolUseId, response });
    },
    [sessionId, respondMutation]
  );

  const isRunning = runningData?.running ?? false;
  const commands = commandsData?.commands ?? [];

  return {
    isRunning,
    send,
    interrupt,
    isInterrupting: interruptMutation.isPending,
    commands,
    pendingUserInput,
    respondToUserInput,
  };
}
