'use client';

import { useCallback, useMemo, useState, use } from 'react';
import Link from 'next/link';
import { AuthGuard } from '@/components/AuthGuard';
import { Header } from '@/components/Header';
import { SessionHeader } from '@/components/SessionHeader';
import { MessageList } from '@/components/MessageList';
import { PromptInput } from '@/components/PromptInput';
import { ClaudeStatusIndicator } from '@/components/ClaudeStatusIndicator';
import { ConnectionStatusIndicator } from '@/components/ConnectionStatusIndicator';
import { Button } from '@/components/ui/button';
import { ActionErrorAlert } from '@/components/ActionErrorAlert';
import { Spinner } from '@/components/ui/spinner';
import { useWorkingIndicator } from '@/hooks/useWorkingIndicator';
import { useClearAttentionWhileViewing } from '@/hooks/useClearAttentionWhileViewing';
import { useSessionState } from '@/hooks/useSessionState';
import { useSessionMessages } from '@/hooks/useSessionMessages';
import { useClaudeState } from '@/hooks/useClaudeState';
import { useSessionStream } from '@/hooks/useSessionStream';
import { useVoiceConfig } from '@/hooks/useVoiceConfig';
import {
  VoicePlaybackProvider,
  defaultPlaybackState,
  useVoicePlayback,
} from '@/hooks/useVoicePlayback';
import { useAutoRead } from '@/hooks/useAutoRead';
import { VoiceControlPanel } from '@/components/voice/VoiceControlPanel';
import type { UploadedAttachment } from '@/lib/attachments';
import { trpc } from '@/lib/trpc';

/** Readings also refresh on every message that moves token usage (useSessionStream). */
const SUBSCRIPTION_USAGE_POLL_MS = 60_000;

function SessionView({ sessionId }: { sessionId: string }) {
  // Single multiplexed SSE stream: opens with a snapshot of the session, its live
  // state, and the newest messages, then keeps all three current.
  const {
    status: streamStatus,
    notFound: sessionNotFound,
    reconnect: reconnectStream,
  } = useSessionStream(sessionId);

  // Session state: data, start/stop/archive
  const {
    session,
    start,
    stop,
    archive,
    rename,
    isStarting,
    isStopping,
    isArchiving,
    actionError,
    dismissActionError,
  } = useSessionState(sessionId);

  // Message state: history, pagination
  const {
    messages,
    isLoading: messagesLoading,
    isFetchingMore,
    hasMore,
    loadFailed,
    fetchMore,
  } = useSessionMessages(sessionId);

  const { data: subscriptionUsage } = trpc.rateLimit.getSessionUsage.useQuery(
    { sessionId },
    {
      enabled: !!session && session.status !== 'archived',
      refetchInterval: SUBSCRIPTION_USAGE_POLL_MS,
    }
  );

  // Claude state: running (main turn), background tasks, send, interrupt, commands
  const {
    isRunning: isClaudeRunning,
    retry: claudeRetry,
    backgroundTasks,
    backgroundActive,
    pendingMessageIds,
    queuedMessageIds,
    rateLimitHold,
    tokenUsage,
    send: sendPrompt,
    interrupt,
    isInterrupting,
    answerQuestion,
    respondToPlan,
    stopBackgroundTask,
    commands,
  } = useClaudeState(sessionId);

  // Something is happening if a turn is active or background tasks run. The server
  // holds the running flag continuously across a message handoff between turns, so
  // there's nothing for the client to bridge here.
  const isWorking = isClaudeRunning || backgroundActive;

  // Working indicator: page title, favicon, and the header logo
  useWorkingIndicator(session?.name, isWorking);

  useClearAttentionWhileViewing(sessionId, session?.attentionAt?.getTime() ?? null);

  // Voice features
  const voiceConfig = useVoiceConfig(sessionId);
  const voicePlayback = useVoicePlayback(voiceConfig.ttsEnabled, voiceConfig.autoRead);
  const [voiceOverlayOpen, setVoiceOverlayOpen] = useState(false);

  // Auto-read: stream TTS as assistant messages arrive during a turn
  const { stopPlayback, onPromptSent } = useAutoRead(voicePlayback, {
    isRunning: isClaudeRunning,
    messages,
    enabled: voiceConfig.autoRead && voiceConfig.ttsEnabled,
  });
  // Memoized: every message bubble reads this context.
  const playbackValue = useMemo(
    () => (voiceConfig.enabled ? { ...voicePlayback, stop: stopPlayback } : defaultPlaybackState),
    [voiceConfig.enabled, voicePlayback, stopPlayback]
  );

  // Send a prompt (also stops any playback). It goes straight to the agent
  // whatever the turn state, so the client just sends. A running session is
  // required. Attachments are passed as their stored names.
  // Returns the send promise so the composer can restore text on failure.
  const handleSendPrompt = useCallback(
    (prompt: string, attachments: UploadedAttachment[] = []) => {
      if (!session || session.status !== 'running') {
        return Promise.reject(new Error('Session is not running'));
      }
      onPromptSent();
      return sendPrompt(
        prompt,
        attachments.length ? attachments.map((a) => a.storedName) : undefined
      );
    },
    [session, sendPrompt, onPromptSent]
  );

  // Interrupt the current turn. Resolves with the text of any prompts the agent
  // hadn't read yet, which the server cancelled — the composer restores them.
  const handleInterrupt = useCallback(
    () => interrupt().then((result) => result.cancelled),
    [interrupt]
  );

  const actionErrorAlert = (
    <ActionErrorAlert
      error={actionError}
      onDismiss={dismissActionError}
      className="rounded-none border-x-0 border-t-0"
    />
  );

  const connectionStatus = (
    <ConnectionStatusIndicator status={streamStatus} onReconnect={reconnectStream} />
  );

  if (!session && !sessionNotFound) {
    return (
      <div className="flex-1 flex flex-col min-h-0">
        <div className="flex-1 flex items-center justify-center">
          <Spinner size="lg" />
        </div>
        {connectionStatus}
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
        <SessionHeader session={session} onArchive={archive} isArchiving={isArchiving} />
        {actionErrorAlert}
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
              sessionId={sessionId}
              messages={messages}
              isLoading={messagesLoading || isFetchingMore}
              hasMore={hasMore}
              loadFailed={loadFailed}
              onLoadMore={fetchMore}
              tokenUsage={tokenUsage}
            />
            <div className="border-t bg-muted/50 px-4 py-3 text-center text-sm text-muted-foreground">
              This session has been archived. You can view the message history but cannot send new
              prompts.
            </div>
          </>
        )}
        {connectionStatus}
      </div>
    );
  }

  return (
    <VoicePlaybackProvider value={playbackValue}>
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
          onAutoReadToggle={voiceConfig.ttsEnabled ? voiceConfig.setAutoRead : undefined}
          onToggleVoiceMode={() => setVoiceOverlayOpen((prev) => !prev)}
          voiceModeActive={voiceOverlayOpen}
        />
        {actionErrorAlert}

        <MessageList
          sessionId={sessionId}
          messages={messages}
          isLoading={messagesLoading || isFetchingMore}
          hasMore={hasMore}
          loadFailed={loadFailed}
          onLoadMore={fetchMore}
          tokenUsage={tokenUsage}
          subscriptionUsage={subscriptionUsage}
          onAnswerQuestion={answerQuestion}
          onRespondToPlan={respondToPlan}
          pendingMessageIds={pendingMessageIds}
          queuedMessageIds={queuedMessageIds}
          isSessionRunning={isClaudeRunning}
        />

        {voiceOverlayOpen && voiceConfig.enabled ? (
          <VoiceControlPanel
            messages={messages}
            isRunning={isClaudeRunning}
            voiceAutoSend={voiceConfig.autoSend}
            // Pass the promise-returning send so the panel can restore the
            // transcript and show an error if the send fails (issue #408).
            onSendPrompt={handleSendPrompt}
            onClose={() => setVoiceOverlayOpen(false)}
            onInterrupt={handleInterrupt}
          />
        ) : (
          <>
            {connectionStatus}
            <ClaudeStatusIndicator
              isRunning={isClaudeRunning}
              retry={claudeRetry}
              backgroundTasks={backgroundTasks}
              backgroundActive={backgroundActive}
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
              voiceEnabled={voiceConfig.sttEnabled}
              voiceAutoSend={voiceConfig.autoSend}
              rateLimitHold={rateLimitHold}
              queuedCount={queuedMessageIds.length}
            />
          </>
        )}
      </div>
    </VoicePlaybackProvider>
  );
}

export default function SessionPage({ params }: { params: Promise<{ id: string }> }) {
  const resolvedParams = use(params);

  return (
    <AuthGuard>
      <div className="h-dvh bg-background flex flex-col overflow-hidden">
        <Header />
        {/* Keyed so each session gets fresh per-session state (see useSessionStream). */}
        <SessionView key={resolvedParams.id} sessionId={resolvedParams.id} />
      </div>
    </AuthGuard>
  );
}
