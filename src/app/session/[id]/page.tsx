'use client';

import { useCallback, useEffect, useRef, use } from 'react';
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

  // Claude state: running, send, interrupt, commands
  const {
    isRunning: isClaudeRunning,
    send: sendPrompt,
    interrupt,
    isInterrupting,
    commands,
  } = useClaudeState(sessionId);

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
  const voicePlayback = useVoicePlayback();

  const handleSendPrompt = useCallback(
    (prompt: string) => {
      if (!session || session.status !== 'running') {
        return;
      }
      sendPrompt(prompt);
    },
    [session, sendPrompt]
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

  // Stop playback when user sends a new prompt
  const handleSendPromptWithVoice = useCallback(
    (prompt: string) => {
      stopWithAutoReadFlag();
      handleSendPrompt(prompt);
    },
    [handleSendPrompt, stopWithAutoReadFlag]
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

    // While Claude is running, enqueue new messages
    if (isClaudeRunning && voiceConfig.autoRead && voiceConfig.enabled && !autoReadStoppedRef.current) {
      const newMessages = getNewAutoReadMessages(messages, autoReadQueuedIdsRef.current);
      for (const msg of newMessages) {
        autoReadQueuedIdsRef.current.add(msg.id);
        voicePlayback.enqueue({ messageId: msg.id, text: msg.text });
      }
    }

    // Detect transition from running -> not running (turn complete)
    if (wasRunning && !isClaudeRunning && voiceConfig.autoRead && voiceConfig.enabled && !autoReadStoppedRef.current) {
      // Ensure the last assistant message gets played even if it arrived in the same
      // render cycle as the turn completion. Check for any unqueued messages.
      const newMessages = getNewAutoReadMessages(messages, autoReadQueuedIdsRef.current);
      for (const msg of newMessages) {
        autoReadQueuedIdsRef.current.add(msg.id);
        voicePlayback.enqueue({ messageId: msg.id, text: msg.text });
      }
    }
  }, [isClaudeRunning, messages, voiceConfig.autoRead, voiceConfig.enabled, voicePlayback]);

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
        />

        <MessageList
          messages={messages}
          isLoading={messagesLoading || isFetchingMore}
          hasMore={hasMore}
          onLoadMore={fetchMore}
          tokenUsage={tokenUsage}
          onSendResponse={handleSendPromptWithVoice}
          isClaudeRunning={isClaudeRunning}
        />

        <ClaudeStatusIndicator isRunning={isClaudeRunning} containerStatus={session.status} />

        <PromptInput
          onSubmit={handleSendPromptWithVoice}
          onInterrupt={interrupt}
          isRunning={isClaudeRunning}
          isInterrupting={isInterrupting}
          disabled={session.status !== 'running'}
          commands={commands}
          voiceEnabled={voiceConfig.enabled}
        />
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
