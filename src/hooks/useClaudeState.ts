import { useCallback } from 'react';
import { trpc } from '@/lib/trpc';
import { useRefetchOnReconnect } from './useRefetchOnReconnect';

/**
 * Represents a pending input request from the agent service.
 * When Claude calls AskUserQuestion or ExitPlanMode, the query pauses
 * and waits for the user to respond.
 */
export interface PendingInputRequest {
  requestId: string;
  toolName: string;
  toolInput: Record<string, unknown>;
  toolUseId: string;
}

/**
 * Hook for managing Claude process state: running status, send prompts, interrupt, respond, and commands.
 *
 * The pending input request is stored in the isRunning query cache so it
 * survives page refreshes (fetched from agent /status on mount) and is
 * updated in real-time via SSE subscriptions.
 */
export function useClaudeState(sessionId: string) {
  const utils = trpc.useUtils();

  // Fetch Claude running state (also includes pending input request for recovery after refresh)
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
        utils.claude.isRunning.setData({ sessionId }, (prev) => ({
          running: trackedData.data.running,
          // When Claude stops, clear any pending input request
          pendingInputRequest: trackedData.data.running
            ? (prev?.pendingInputRequest ?? null)
            : null,
        }));
        if (!trackedData.data.running) {
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

  // Subscribe to input request events via SSE - update isRunning cache with the request
  trpc.sse.onInputRequest.useSubscription(
    { sessionId },
    {
      onData: (trackedData) => {
        const event = trackedData.data;
        utils.claude.isRunning.setData({ sessionId }, (prev) => ({
          running: prev?.running ?? true,
          pendingInputRequest: {
            requestId: event.requestId,
            toolName: event.toolName,
            toolInput: event.toolInput,
            toolUseId: event.toolUseId,
          },
        }));
      },
      onError: (err) => {
        console.error('Input request SSE error:', err);
      },
    }
  );

  const sendMutation = trpc.claude.send.useMutation();
  const interruptMutation = trpc.claude.interrupt.useMutation();
  const respondMutation = trpc.claude.respond.useMutation();

  const send = useCallback(
    (prompt: string) => {
      sendMutation.mutate({ sessionId, prompt });
    },
    [sessionId, sendMutation]
  );

  const interrupt = useCallback(() => {
    interruptMutation.mutate({ sessionId });
  }, [sessionId, interruptMutation]);

  const respond = useCallback(
    (options: {
      requestId: string;
      behavior: 'allow' | 'deny';
      updatedInput?: Record<string, unknown>;
      message?: string;
    }) => {
      // Optimistically clear the pending input request from cache
      utils.claude.isRunning.setData({ sessionId }, (prev) => ({
        running: prev?.running ?? true,
        pendingInputRequest: null,
      }));
      respondMutation.mutate({ sessionId, ...options });
    },
    [sessionId, respondMutation, utils.claude.isRunning]
  );

  const isRunning = runningData?.running ?? false;
  const commands = commandsData?.commands ?? [];
  const pendingInputRequest = runningData?.pendingInputRequest ?? null;

  return {
    isRunning,
    send,
    interrupt,
    respond,
    isInterrupting: interruptMutation.isPending,
    commands,
    pendingInputRequest,
  };
}
