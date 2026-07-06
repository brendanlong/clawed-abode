'use client';

import { useCallback, useEffect, useRef, useState, use } from 'react';
import Link from 'next/link';
import { AuthGuard } from '@/components/AuthGuard';
import { Header } from '@/components/Header';
import { SessionHeader } from '@/components/SessionHeader';
import { MessageList } from '@/components/MessageList';
import { PromptInput } from '@/components/PromptInput';
import { ClaudeStatusIndicator } from '@/components/ClaudeStatusIndicator';
import { ConnectionStatusIndicator } from '@/components/ConnectionStatusIndicator';
import { Button } from '@/components/ui/button';
import { Spinner } from '@/components/ui/spinner';
import { useNotification } from '@/hooks/useNotification';
import { useWorkingIndicator } from '@/hooks/useWorkingIndicator';
import { useWorkingContext } from '@/lib/working-context';
import { useSessionState } from '@/hooks/useSessionState';
import { useSessionMessages } from '@/hooks/useSessionMessages';
import { useClaudeState } from '@/hooks/useClaudeState';
import { useSessionStream } from '@/hooks/useSessionStream';
import { useWorkCompleteNotification } from '@/hooks/useWorkCompleteNotification';
import { useVoiceConfig } from '@/hooks/useVoiceConfig';
import { useVoicePlayback, VoicePlaybackContext } from '@/hooks/useVoicePlayback';
import { getNewAutoReadMessages } from '@/lib/auto-read-helpers';
import { VoiceControlPanel } from '@/components/voice/VoiceControlPanel';
import type { UploadedAttachment } from '@/lib/attachments';

function SessionView({ sessionId }: { sessionId: string }) {
  // Session state: data, start/stop/archive
  const {
    session,
    isLoading: sessionLoading,
    start,
    stop,
    archive,
    rename,
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
    historyLoaded,
    newestSequence,
  } = useSessionMessages(sessionId);

  // Single multiplexed SSE stream: fans live events into the relevant caches.
  // Anchored to the loaded history so no messages are missed between snapshots.
  const { status: streamStatus } = useSessionStream(sessionId, { historyLoaded, newestSequence });

  // Claude state: running (main turn), background tasks, send, interrupt, commands
  const {
    isRunning: isClaudeRunning,
    retry: claudeRetry,
    backgroundTasks,
    backgroundActive,
    queuedMessages,
    send: sendPrompt,
    cancelQueued,
    interrupt,
    isInterrupting,
    answerQuestion,
    respondToPlan,
    stopBackgroundTask,
    commands,
  } = useClaudeState(sessionId);

  // Server-owned queue: messages sent while a turn was active (async "btw mode").
  // The server holds them (unpersisted) and streams them here over the `queued`
  // SSE channel; they're shown pinned below the transcript, each removable via ✕
  // (claude.cancelQueued). The server flushes them as one combined turn when the
  // turn ends naturally — an interrupt leaves them queued (see interruptClaude).

  // Something is happening if a turn is active or background tasks run. The server
  // holds turnActive continuously across a natural-flush handoff, so there's no
  // client-side flush bridge to account for here.
  const isWorking = isClaudeRunning || backgroundActive;

  // Working indicator: page title and favicon
  useWorkingIndicator(session?.name, isWorking);

  // Update global working state for the header logo
  const { setWorking } = useWorkingContext();
  useEffect(() => {
    setWorking(isWorking);
    return () => setWorking(false);
  }, [isWorking, setWorking]);

  // Request notification permission on mount
  const { requestPermission, permission, showNotification } = useNotification();
  useEffect(() => {
    // Request permission if not yet decided
    if (permission === 'default') {
      requestPermission();
    }
  }, [permission, requestPermission]);

  // Show notification when Claude finishes processing (if tab was hidden). The
  // server holds turnActive true across a natural queued-flush handoff, so
  // isClaudeRunning alone won't dip between back-to-back queued turns.
  useWorkCompleteNotification(session?.name, isClaudeRunning, showNotification);

  // Voice features
  const voiceConfig = useVoiceConfig(sessionId);
  const voicePlayback = useVoicePlayback(voiceConfig.ttsSpeed, voiceConfig.voiceURI);
  const [voiceOverlayOpen, setVoiceOverlayOpen] = useState(false);

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

  // Send a prompt (also stops any playback). The server decides whether it starts
  // a turn or is queued (async "btw mode") — the client always just sends. A
  // running session is required. Attachments are passed as their stored names.
  const handleSendPrompt = useCallback(
    (prompt: string, attachments: UploadedAttachment[] = []) => {
      if (!session || session.status !== 'running') {
        return;
      }
      stopWithAutoReadFlag();
      sendPrompt(prompt, attachments.length ? attachments.map((a) => a.storedName) : undefined);
    },
    [session, sendPrompt, stopWithAutoReadFlag]
  );

  // Adapter for callers that only produce text (plan responses, voice transcripts).
  const handleSendText = useCallback(
    (prompt: string) => handleSendPrompt(prompt),
    [handleSendPrompt]
  );

  // Remove a queued message before it flushes (server-owned; ✕ on a queued bubble).
  const handleCancelQueued = useCallback((id: string) => cancelQueued(id), [cancelQueued]);

  // Interrupt the current turn. Queued messages are deliberately left queued on
  // the server (never fired as a fresh turn by the interrupt); the user can ✕
  // remove any they no longer want.
  const handleInterrupt = useCallback(() => interrupt(), [interrupt]);

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
          onRename={rename}
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
          onSendResponse={handleSendText}
          onAnswerQuestion={answerQuestion}
          onRespondToPlan={respondToPlan}
          queuedMessages={queuedMessages}
          onCancelQueued={handleCancelQueued}
          isSessionRunning={isClaudeRunning}
        />

        {voiceOverlayOpen && voiceConfig.enabled ? (
          <VoiceControlPanel
            sessionId={sessionId}
            messages={messages}
            isRunning={isClaudeRunning}
            onSendPrompt={handleSendText}
            onClose={() => setVoiceOverlayOpen(false)}
            onInterrupt={handleInterrupt}
          />
        ) : (
          <>
            <ConnectionStatusIndicator status={streamStatus} />
            <ClaudeStatusIndicator
              isRunning={isClaudeRunning}
              retry={claudeRetry}
              backgroundTasks={backgroundTasks}
              onStopBackgroundTask={stopBackgroundTask}
              containerStatus={session.status}
            />
            <PromptInput
              sessionId={sessionId}
              onSubmit={handleSendPrompt}
              onInterrupt={handleInterrupt}
              isRunning={isClaudeRunning}
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
