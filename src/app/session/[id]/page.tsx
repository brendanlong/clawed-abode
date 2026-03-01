'use client';

import { useCallback, useEffect, useRef, useState, use } from 'react';
import Link from 'next/link';
import { AuthGuard } from '@/components/AuthGuard';
import { Header } from '@/components/Header';
import { SessionHeader } from '@/components/SessionHeader';
import { MessageList } from '@/components/MessageList';
import { PromptInput } from '@/components/PromptInput';
import { ClaudeStatusIndicator } from '@/components/ClaudeStatusIndicator';
import { Button } from '@/components/ui/button';
import { Spinner } from '@/components/ui/spinner';
import { useNotification } from '@/hooks/useNotification';
import { useWorkingIndicator } from '@/hooks/useWorkingIndicator';
import { useWorkingContext } from '@/lib/working-context';
import { useSessionState } from '@/hooks/useSessionState';
import { useSessionMessages } from '@/hooks/useSessionMessages';
import { useClaudeState } from '@/hooks/useClaudeState';
import { useWorkCompleteNotification } from '@/hooks/useWorkCompleteNotification';
import { useVoiceConfig } from '@/hooks/useVoiceConfig';
import { useVoicePlayback, VoicePlaybackContext } from '@/hooks/useVoicePlayback';
import { getNewAutoReadMessages } from '@/lib/auto-read-helpers';
import { VoiceControlPanel } from '@/components/voice/VoiceControlPanel';

function SessionView({ sessionId }: { sessionId: string }) {
  // Session state: data, start/stop/archive
  const {
    session,
    isLoading: sessionLoading,
    start,
    stop,
    archive,
    isStarting,
    isStopping,
    isArchiving,
  } = useSessionState(sessionId);

  // Message state: history, pagination, token usage
  const {
    messages,
    isLoading: messagesLoading,
    isFetchingMore,
    hasMore,
    fetchMore,
    tokenUsage,
  } = useSessionMessages(sessionId);

  // Claude state: running, send, interrupt, commands, user input
  const {
    isRunning: isClaudeRunning,
    send: sendPrompt,
    interrupt,
    isInterrupting,
    commands,
    pendingUserInput,
    respondToUserInput,
  } = useClaudeState(sessionId);

  // Whether Claude is waiting for user input (canUseTool callback paused)
  const isWaitingForUserInput = !!pendingUserInput;

  // Working indicator: page title and favicon
  useWorkingIndicator(session?.name, isClaudeRunning);

  // Update global working state for the header logo
  const { setWorking } = useWorkingContext();
  useEffect(() => {
    setWorking(isClaudeRunning);
    return () => setWorking(false);
  }, [isClaudeRunning, setWorking]);

  // Request notification permission on mount
  const { requestPermission, permission, showNotification } = useNotification();
  useEffect(() => {
    // Request permission if not yet decided
    if (permission === 'default') {
      requestPermission();
    }
  }, [permission, requestPermission]);

  // Show notification when Claude finishes processing (if tab was hidden)
  useWorkCompleteNotification(session?.name, isClaudeRunning, showNotification);

  // Voice features
  const voiceConfig = useVoiceConfig(sessionId);
  const voicePlayback = useVoicePlayback(voiceConfig.ttsSpeed, voiceConfig.voiceURI);
  const [voiceOverlayOpen, setVoiceOverlayOpen] = useState(false);

  const handleSendPrompt = useCallback(
    (prompt: string) => {
      if (!session || session.status !== 'running') {
        return;
      }
      sendPrompt(prompt);
    },
    [session, sendPrompt]
  );

  /**
   * Unified callback for sending prompts or responding to user input requests.
   * Routes through respondToUserInput when the SDK is waiting for a canUseTool response.
   */
  const handleSendOrRespond = useCallback(
    (text: string) => {
      if (!session || session.status !== 'running') {
        return;
      }

      if (pendingUserInput) {
        const { toolName, toolUseId, input } = pendingUserInput;

        if (toolName === 'AskUserQuestion') {
          // Map response text to question answers
          const questions = (input.questions as Array<{ question: string }>) || [];
          const answers: Record<string, string> = {};
          for (const q of questions) {
            answers[q.question] = text;
          }
          respondToUserInput(toolUseId, {
            behavior: 'allow',
            updatedInput: { questions: input.questions, answers },
          });
        } else if (toolName === 'ExitPlanMode') {
          // Allow the plan
          respondToUserInput(toolUseId, {
            behavior: 'allow',
            updatedInput: input,
          });
        } else {
          // Unknown user input tool - allow with original input
          respondToUserInput(toolUseId, {
            behavior: 'allow',
            updatedInput: input,
          });
        }
      } else {
        handleSendPrompt(text);
      }
    },
    [session, pendingUserInput, respondToUserInput, handleSendPrompt]
  );

  // Auto-read: stream TTS as assistant messages arrive during a turn
  const prevRunningRef = useRef(false);
  const autoReadQueuedIdsRef = useRef<Set<string>>(new Set());
  const autoReadStoppedRef = useRef(false);

  // Wrap voicePlayback.stop to also set the stopped flag for this turn.
  // When the user manually stops playback during a turn, we don't want to
  // keep auto-queuing new messages for the rest of that turn.
  const stopWithAutoReadFlag = useCallback(() => {
    autoReadStoppedRef.current = true;
    voicePlayback.stop();
  }, [voicePlayback]);

  // Stop playback when user sends a new prompt or responds to user input
  const handleSendPromptWithVoice = useCallback(
    (prompt: string) => {
      stopWithAutoReadFlag();
      handleSendOrRespond(prompt);
    },
    [handleSendOrRespond, stopWithAutoReadFlag]
  );

  // During a turn: enqueue new assistant text messages as they arrive
  useEffect(() => {
    const wasRunning = prevRunningRef.current;
    prevRunningRef.current = isClaudeRunning;

    // Detect transition from not running -> running (new turn starts)
    if (!wasRunning && isClaudeRunning) {
      autoReadQueuedIdsRef.current = new Set();
      autoReadStoppedRef.current = false;
    }

    // Enqueue new messages while running, and also do a final check on turn
    // completion to catch any messages that arrived in the same render cycle.
    const shouldEnqueue =
      (isClaudeRunning || (wasRunning && !isClaudeRunning)) &&
      voiceConfig.autoRead &&
      voiceConfig.enabled &&
      !autoReadStoppedRef.current;

    if (shouldEnqueue) {
      const newMessages = getNewAutoReadMessages(messages, autoReadQueuedIdsRef.current);
      for (const msg of newMessages) {
        autoReadQueuedIdsRef.current.add(msg.id);
        voicePlayback.enqueue({ messageId: msg.id, text: msg.text });
      }
    }
  }, [isClaudeRunning, messages, voiceConfig.autoRead, voiceConfig.enabled, voicePlayback.enqueue]);

  if (sessionLoading) {
    return (
      <div className="flex-1 flex items-center justify-center">
        <Spinner size="lg" />
      </div>
    );
  }

  if (!session) {
    return (
      <div className="flex-1 flex flex-col items-center justify-center">
        <p className="text-muted-foreground">Session not found</p>
        <Button variant="link" asChild className="mt-4">
          <Link href="/">Back to sessions</Link>
        </Button>
      </div>
    );
  }

  // Show creation progress, error state, or archived state
  if (
    session.status === 'creating' ||
    session.status === 'error' ||
    session.status === 'archived'
  ) {
    return (
      <div className="flex-1 flex flex-col min-h-0">
        <SessionHeader
          session={session}
          onStart={() => {}}
          onStop={() => {}}
          isStarting={false}
          isStopping={false}
        />
        {session.status === 'creating' && (
          <div className="flex-1 flex flex-col items-center justify-center gap-4">
            <Spinner size="lg" />
            <p className="text-muted-foreground">
              {session.statusMessage || 'Setting up session...'}
            </p>
          </div>
        )}
        {session.status === 'error' && (
          <div className="flex-1 flex flex-col items-center justify-center gap-4">
            <div className="text-destructive text-lg">Setup Failed</div>
            <p className="text-muted-foreground max-w-md text-center">
              {session.statusMessage || 'An unknown error occurred'}
            </p>
            <Button variant="outline" asChild className="mt-4">
              <Link href="/">Back to sessions</Link>
            </Button>
          </div>
        )}
        {session.status === 'archived' && (
          <>
            <MessageList
              messages={messages}
              isLoading={messagesLoading || isFetchingMore}
              hasMore={hasMore}
              onLoadMore={fetchMore}
              tokenUsage={tokenUsage}
              onSendResponse={() => {}}
              isClaudeRunning={false}
            />
            <div className="border-t bg-muted/50 px-4 py-3 text-center text-sm text-muted-foreground">
              This session has been archived. You can view the message history but cannot send new
              prompts.
            </div>
          </>
        )}
      </div>
    );
  }

  return (
    <VoicePlaybackContext.Provider
      value={
        voiceConfig.enabled
          ? { ...voicePlayback, stop: stopWithAutoReadFlag }
          : {
              enabled: false,
              isPlaying: false,
              currentMessageId: null,
              isLoading: false,
              supportsPause: false,
              play: async () => {},
              playSequential: () => {},
              enqueue: () => {},
              pause: () => {},
              stop: () => {},
              restart: async () => {},
            }
      }
    >
      <div className="flex-1 flex flex-col min-h-0">
        <SessionHeader
          session={session}
          onStart={start}
          onStop={stop}
          onArchive={archive}
          isStarting={isStarting}
          isStopping={isStopping}
          isArchiving={isArchiving}
          voiceEnabled={voiceConfig.enabled}
          autoRead={voiceConfig.autoRead}
          onAutoReadToggle={voiceConfig.setAutoRead}
          onToggleVoiceMode={() => setVoiceOverlayOpen((prev) => !prev)}
          voiceModeActive={voiceOverlayOpen}
        />

        <MessageList
          messages={messages}
          isLoading={messagesLoading || isFetchingMore}
          hasMore={hasMore}
          onLoadMore={fetchMore}
          tokenUsage={tokenUsage}
          onSendResponse={handleSendPromptWithVoice}
          isClaudeRunning={isClaudeRunning}
          isWaitingForUserInput={isWaitingForUserInput}
        />

        {voiceOverlayOpen && voiceConfig.enabled ? (
          <VoiceControlPanel
            sessionId={sessionId}
            messages={messages}
            isRunning={isClaudeRunning && !isWaitingForUserInput}
            onSendPrompt={handleSendPromptWithVoice}
            onClose={() => setVoiceOverlayOpen(false)}
            onInterrupt={interrupt}
          />
        ) : (
          <>
            <ClaudeStatusIndicator
              isRunning={isClaudeRunning && !isWaitingForUserInput}
              containerStatus={session.status}
            />
            <PromptInput
              onSubmit={handleSendPromptWithVoice}
              onInterrupt={interrupt}
              isRunning={isClaudeRunning && !isWaitingForUserInput}
              isInterrupting={isInterrupting}
              disabled={session.status !== 'running'}
              commands={commands}
              voiceEnabled={voiceConfig.enabled}
              voiceAutoSend={voiceConfig.autoSend}
            />
          </>
        )}
      </div>
    </VoicePlaybackContext.Provider>
  );
}

export default function SessionPage({ params }: { params: Promise<{ id: string }> }) {
  const resolvedParams = use(params);

  return (
    <AuthGuard>
      <div className="h-screen bg-background flex flex-col overflow-hidden">
        <Header />
        <SessionView sessionId={resolvedParams.id} />
      </div>
    </AuthGuard>
  );
}
