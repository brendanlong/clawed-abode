'use client';

import Link from 'next/link';
import { ChevronLeft, Mic } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { SessionStatusToggle } from '@/components/SessionStatusToggle';
import { SessionActionButton } from '@/components/SessionActionButton';
import { EditableSessionName } from '@/components/EditableSessionName';
import { VoiceAutoReadToggle } from '@/components/voice/VoiceAutoReadToggle';
import { OpenInEditorButton } from '@/components/OpenInEditorButton';
import { SessionSettingsButton } from '@/components/SessionSettingsButton';
import { PrStatusIndicator } from '@/components/PrStatusIndicator';
import type { PullRequestInfo } from '@/lib/pull-request';
import { extractRepoFullName } from '@/lib/utils';

interface SessionHeaderProps {
  session: {
    id: string;
    name: string;
    repoUrl: string | null;
    branch: string | null;
    status: string;
    statusMessage?: string | null;
    claudeModel?: string | null;
    rateLimitPauseEnabled?: boolean | null;
    rateLimitPauseThreshold?: number | null;
    pullRequest?: PullRequestInfo | null;
  };
  onStart: () => void;
  onStop: () => void;
  onArchive?: () => void;
  onRename?: (name: string) => void;
  isStarting: boolean;
  isStopping: boolean;
  isArchiving?: boolean;
  voiceEnabled?: boolean;
  autoRead?: boolean;
  onAutoReadToggle?: (value: boolean) => void;
  onToggleVoiceMode?: () => void;
  voiceModeActive?: boolean;
}

export function SessionHeader({
  session,
  onStart,
  onStop,
  onArchive,
  onRename,
  isStarting,
  isStopping,
  isArchiving = false,
  voiceEnabled = false,
  autoRead = false,
  onAutoReadToggle,
  onToggleVoiceMode,
  voiceModeActive = false,
}: SessionHeaderProps) {
  const repoName = session.repoUrl ? extractRepoFullName(session.repoUrl) : null;

  return (
    <div className="border-b bg-background px-4 py-3">
      <div className="flex items-center justify-between gap-3">
        <div className="flex items-center gap-3 min-w-0">
          <Button variant="ghost" size="icon" className="shrink-0" asChild>
            <Link href="/" aria-label="Back to sessions">
              <ChevronLeft className="w-5 h-5" />
            </Link>
          </Button>
          <div className="min-w-0">
            {onRename ? (
              <EditableSessionName name={session.name} onRename={onRename} />
            ) : (
              <h1 className="font-semibold truncate" title={session.name}>
                {session.name}
              </h1>
            )}
            {repoName && (
              <p className="text-sm text-muted-foreground truncate flex items-center gap-2">
                {repoName}
                {session.pullRequest && <PrStatusIndicator pullRequest={session.pullRequest} />}
              </p>
            )}
          </div>
        </div>

        <div className="flex flex-col items-end gap-1 shrink-0">
          <div className="flex items-center gap-1">
            {session.status !== 'archived' && (
              <SessionSettingsButton
                sessionId={session.id}
                claudeModel={session.claudeModel ?? null}
                rateLimitPauseEnabled={session.rateLimitPauseEnabled ?? null}
                rateLimitPauseThreshold={session.rateLimitPauseThreshold ?? null}
              />
            )}
            <OpenInEditorButton sessionId={session.id} />
            {voiceEnabled && onToggleVoiceMode && (
              <Button
                variant={voiceModeActive ? 'secondary' : 'ghost'}
                size="icon"
                onClick={onToggleVoiceMode}
                title={voiceModeActive ? 'Exit voice mode' : 'Enter voice mode'}
                className="shrink-0 h-8 w-8"
              >
                <Mic className="h-4 w-4" />
              </Button>
            )}
            {voiceEnabled && onAutoReadToggle && (
              <VoiceAutoReadToggle autoRead={autoRead} onToggle={onAutoReadToggle} />
            )}
            <SessionStatusToggle
              status={session.status}
              onStart={onStart}
              onStop={onStop}
              isStarting={isStarting}
              isStopping={isStopping}
            />
          </div>
          {(session.status === 'stopped' || session.status === 'running') && onArchive && (
            <SessionActionButton
              action="archive"
              onClick={onArchive}
              isPending={isArchiving}
              variant="secondary"
              sessionName={session.name}
            />
          )}
        </div>
      </div>
    </div>
  );
}
