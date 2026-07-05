'use client';

import { useCallback, useEffect, useRef, useState, use } from 'react';
import Link from 'next/link';
import { AuthGuard } from '@/components/AuthGuard';
import { Header } from '@/components/Header';
import { SessionHeader } from '@/components/SessionHeader';
import { MessageList } from '@/components/MessageList';
import { PromptInput, type ComposerDraft } from '@/components/PromptInput';
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
import type { PendingMessage } from '@/lib/pending-message';

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
    send: sendPrompt,
    sendBatch,
    isBatchSending,
    interrupt,
    isInterrupting,
    answerQuestion,
    respondToPlan,
    stopBackgroundTask,
    commands,
  } = useClaudeState(sessionId);

  // Client-held pending queue: messages the user typed while a turn was active
  // (async "btw mode"). Shown pinned at the bottom of the transcript, individually
  // removable, and flushed together via sendBatch when the turn ends. Not persisted
  // until they flush — cancelling or reclaiming one never touches the DB.
  const [pendingMessages, setPendingMessages] = useState<PendingMessage[]>([]);
  const pendingIdRef = useRef(0);
  // A draft to reclaim into the composer (the pending messages, on interrupt).
  const [restoreDraft, setRestoreDraft] = useState<ComposerDraft | null>(null);
  const draftNonceRef = useRef(0);
  // Bridges the gap between a turn ending and the flushed turn starting, so the
  // "working" signal stays continuously true (no premature work-complete
  // notification / no flicker) across the client-driven flush.
  const [flushing, setFlushing] = useState(false);

  // Something is happening if a turn is active, background tasks run, or messages
  // are queued/flushing.
  const isWorking = isClaudeRunning || backgroundActive || pendingMessages.length > 0 || flushing;

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

  // Show notification when Claude finishes processing (if tab was hidden). Include
  // pending/flushing so a queued-message handoff doesn't fire a premature "finished".
  useWorkCompleteNotification(
    session?.name,
    isClaudeRunning || pendingMessages.length > 0 || flushing,
    showNotification
  );

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

  // Send a prompt (also stops any playback). While a turn is active, the message
  // is held in the client-side pending queue and flushed when the turn ends;
  // otherwise it starts a turn immediately. Accepts full attachments so pending
  // messages keep enough to display chips and be reclaimed on interrupt.
  const handleSendPrompt = useCallback(
    (prompt: string, attachments: UploadedAttachment[] = []) => {
      if (!session || session.status !== 'running') {
        return;
      }
      stopWithAutoReadFlag();
      if (isClaudeRunning) {
        setPendingMessages((prev) => [
          ...prev,
          { id: `pending-${pendingIdRef.current++}`, text: prompt, attachments },
        ]);
      } else {
        sendPrompt(prompt, attachments.length ? attachments.map((a) => a.storedName) : undefined);
      }
    },
    [session, isClaudeRunning, sendPrompt, stopWithAutoReadFlag]
  );

  // Adapter for callers that only produce text (plan responses, voice transcripts).
  const handleSendText = useCallback(
    (prompt: string) => handleSendPrompt(prompt),
    [handleSendPrompt]
  );

  const handleCancelPending = useCallback((id: string) => {
    setPendingMessages((prev) => prev.filter((m) => m.id !== id));
  }, []);

  const handleDraftConsumed = useCallback(() => setRestoreDraft(null), []);

  // Interrupt the current turn and reclaim any pending messages into the composer
  // (their text joined by newlines, attachments restored) so nothing is lost.
  const handleInterrupt = useCallback(() => {
    if (pendingMessages.length > 0) {
      const text = pendingMessages
        .map((m) => m.text)
        .filter((t) => t.trim().length > 0)
        .join('\n');
      const attachments = pendingMessages.flatMap((m) => m.attachments);
      draftNonceRef.current += 1;
      setRestoreDraft({ text, attachments, nonce: draftNonceRef.current });
      setPendingMessages([]);
    }
    interrupt();
  }, [pendingMessages, interrupt]);

  // Flush the pending queue as one turn when the current turn ends. Keyed on the
  // running true->false transition; `flushing` bridges until the flushed turn starts.
  // Only flush while the session is still running — if `isClaudeRunning` fell
  // because the session was stopped (header Stop), keep the pending drafts visible
  // rather than firing a doomed sendBatch and dropping them.
  const isSessionRunning = session?.status === 'running';
  const prevRunningForFlushRef = useRef(false);
  useEffect(() => {
    const wasRunning = prevRunningForFlushRef.current;
    prevRunningForFlushRef.current = isClaudeRunning;
    if (wasRunning && !isClaudeRunning && isSessionRunning && pendingMessages.length > 0) {
      setFlushing(true);
      sendBatch(
        pendingMessages.map((m) => ({
          prompt: m.text,
          attachments: m.attachments.length ? m.attachments.map((a) => a.storedName) : undefined,
        }))
      );
      setPendingMessages([]);
    }
  }, [isClaudeRunning, isSessionRunning, pendingMessages, sendBatch]);

  // Clear the flushing bridge once the flushed turn starts, or if the batch send
  // settled without starting one (e.g. an error) so `isWorking` can't stick true.
  const prevBatchSendingRef = useRef(false);
  useEffect(() => {
    const wasSending = prevBatchSendingRef.current;
    prevBatchSendingRef.current = isBatchSending;
    if (isClaudeRunning || (wasSending && !isBatchSending)) {
      setFlushing(false);
    }
  }, [isClaudeRunning, isBatchSending]);

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
          pendingMessages={pendingMessages}
          onCancelPending={handleCancelPending}
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
              restoreDraft={restoreDraft}
              onDraftConsumed={handleDraftConsumed}
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
