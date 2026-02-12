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

  // Stop playback when user sends a new prompt
  const handleSendPromptWithVoice = useCallback(
    (prompt: string) => {
      voicePlayback.stop();
      handleSendPrompt(prompt);
    },
    [handleSendPrompt, voicePlayback]
  );

  // Auto-read: detect when Claude finishes a turn and speak the last assistant message
  const prevRunningRef = useRef(false);
  useEffect(() => {
    const wasRunning = prevRunningRef.current;
    prevRunningRef.current = isClaudeRunning;

    // Detect transition from running -> not running (turn complete)
    if (wasRunning && !isClaudeRunning && voiceConfig.autoRead && voiceConfig.enabled) {
      // Find the last assistant message
      for (let i = messages.length - 1; i >= 0; i--) {
        const msg = messages[i];
        if (msg.type === 'assistant' && msg.id && !msg.id.startsWith('partial-')) {
          // Extract text content from the message
          const content = msg.content as Record<string, unknown> | undefined;
          const innerMsg = content?.message as Record<string, unknown> | undefined;
          const blocks = innerMsg?.content;
          if (Array.isArray(blocks)) {
            const textParts = blocks
              .filter(
                (b: Record<string, unknown>) => b.type === 'text' && typeof b.text === 'string'
              )
              .map((b: Record<string, unknown>) => b.text as string);
            const fullText = textParts.join('\n');
            if (fullText.trim()) {
              voicePlayback.play(msg.id, fullText);
            }
          }
          break;
        }
      }
    }
  }, [isClaudeRunning, messages, voiceConfig.autoRead, voiceConfig.enabled, voicePlayback]);

  // Track whether we've already sent the initial prompt
  const initialPromptSentRef = useRef(false);
  const prevStatusRef = useRef<string | undefined>(undefined);

  // Send the initial prompt when session transitions to running for the first time
  useEffect(() => {
    if (!session) return;

    const wasCreating = prevStatusRef.current === 'creating';
    const isNowRunning = session.status === 'running';
    const hasInitialPrompt = !!session.initialPrompt;
    const noMessagesSent = messages.length === 0;

    // Update previous status
    prevStatusRef.current = session.status;

    // Only send initial prompt on transition from creating to running,
    // when there's a prompt, no messages have been sent yet, and we haven't already sent it
    if (
      wasCreating &&
      isNowRunning &&
      hasInitialPrompt &&
      noMessagesSent &&
      !initialPromptSentRef.current &&
      session.initialPrompt // TypeScript narrowing
    ) {
      initialPromptSentRef.current = true;
      sendPrompt(session.initialPrompt);
    }
  }, [session, messages.length, sendPrompt]);

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
          ? voicePlayback
          : {
              enabled: false,
              isPlaying: false,
              currentMessageId: null,
              isLoading: false,
              play: async () => {},
              pause: () => {},
              stop: () => {},
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
