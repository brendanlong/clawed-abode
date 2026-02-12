'use client';

import Link from 'next/link';
import { Button } from '@/components/ui/button';
import { SessionStatusToggle } from '@/components/SessionStatusToggle';
import { SessionActionButton } from '@/components/SessionActionButton';
import { VoiceAutoReadToggle } from '@/components/voice/VoiceAutoReadToggle';

interface SessionHeaderProps {
  session: {
    id: string;
    name: string;
    repoUrl: string;
    branch: string;
    status: string;
    statusMessage?: string | null;
    initialPrompt?: string | null;
  };
  onStart: () => void;
  onStop: () => void;
  onArchive?: () => void;
  isStarting: boolean;
  isStopping: boolean;
  isArchiving?: boolean;
  voiceEnabled?: boolean;
  autoRead?: boolean;
  onAutoReadToggle?: (value: boolean) => void;
}

export function SessionHeader({
  session,
  onStart,
  onStop,
  onArchive,
  isStarting,
  isStopping,
  isArchiving = false,
  voiceEnabled = false,
  autoRead = false,
  onAutoReadToggle,
}: SessionHeaderProps) {
  const repoName = session.repoUrl.replace('https://github.com/', '').replace('.git', '');

  return (
    <div className="border-b bg-background px-4 py-3">
      <div className="flex items-center justify-between gap-3">
        <div className="flex items-center gap-3 min-w-0">
          <Button variant="ghost" size="icon" className="shrink-0" asChild>
            <Link href="/">
              <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  strokeWidth={2}
                  d="M15 19l-7-7 7-7"
                />
              </svg>
            </Link>
          </Button>
          <div className="min-w-0">
            <h1 className="font-semibold break-words">{session.name}</h1>
            <p className="text-sm text-muted-foreground truncate">{repoName}</p>
          </div>
        </div>

        <div className="flex flex-col items-end gap-1 shrink-0">
          <div className="flex items-center gap-1">
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
