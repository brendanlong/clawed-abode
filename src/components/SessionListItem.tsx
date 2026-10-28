'use client';

import Link from 'next/link';
import { BellRing } from 'lucide-react';
import { trpc } from '@/lib/trpc';
import { extractRepoFullName } from '@/lib/utils';
import { deriveSessionDisplayStatus } from '@/lib/session-display-status';
import { SessionStatusIcon } from '@/components/SessionStatusIcon';
import { SessionActionButton } from '@/components/SessionActionButton';
import { PrStatusIndicator } from '@/components/PrStatusIndicator';
import { ActionErrorAlert } from '@/components/ActionErrorAlert';
import { useActionError } from '@/hooks/useActionError';
import type { Session } from '@/hooks/useSessionList';

export interface SessionListItemProps {
  session: Session;
}

/**
 * Session list item that owns its own mutation state.
 * Each instance tracks its own pending start/stop/archive independently.
 */
export function SessionListItem({ session }: SessionListItemProps) {
  const repoName = session.repoUrl ? extractRepoFullName(session.repoUrl) : null;

  const { error, dismiss, handlersFor } = useActionError();
  const startMutation = trpc.sessions.start.useMutation(handlersFor('start session'));
  const stopMutation = trpc.sessions.stop.useMutation(handlersFor('stop session'));
  const archiveMutation = trpc.sessions.delete.useMutation(handlersFor('archive session'));
  const starMutation = trpc.sessions.setStarred.useMutation(handlersFor('star session'));

  return (
    <li
      className={`p-4 hover:bg-muted/50 transition-all ${archiveMutation.isPending ? 'opacity-50 pointer-events-none' : ''}`}
    >
      <div className="flex items-center justify-between">
        <div className="flex-1 min-w-0">
          <Link href={`/session/${session.id}`} className="block">
            <p className="text-sm font-medium text-primary truncate hover:underline">
              {session.name}
            </p>
            <p className="mt-1 text-sm text-muted-foreground truncate">
              {repoName ? (
                <>
                  {repoName}
                  <span className="mx-1">·</span>
                  {session.branch}
                </>
              ) : (
                'No repository'
              )}
            </p>
            {session.attentionSummary && (
              <p className="mt-1 flex items-center gap-1.5 text-sm font-medium text-primary">
                <BellRing className="h-3.5 w-3.5 shrink-0" aria-label="Needs you" />
                <span className="truncate">{session.attentionSummary}</span>
              </p>
            )}
          </Link>
        </div>

        <div className="flex shrink-0 items-center">
          {session.pullRequest && <PrStatusIndicator pullRequest={session.pullRequest} />}
          <SessionStatusIcon
            status={deriveSessionDisplayStatus(
              session.status,
              session.turnActive,
              session.backgroundActive,
              session.rateLimitPaused
            )}
          />

          <div className="flex items-center">
            {session.canStar && (
              <SessionActionButton
                action={session.starred ? 'unstar' : 'star'}
                onClick={() =>
                  starMutation.mutate({ sessionId: session.id, starred: !session.starred })
                }
                isPending={starMutation.isPending}
                variant="ghost"
                className="text-muted-foreground"
              />
            )}
            {session.canStart && (
              <SessionActionButton
                action="start"
                onClick={() => startMutation.mutate({ sessionId: session.id })}
                isPending={startMutation.isPending}
                variant="ghost"
              />
            )}
            {session.canStop && (
              <SessionActionButton
                action="stop"
                onClick={() => stopMutation.mutate({ sessionId: session.id })}
                isPending={stopMutation.isPending}
                variant="ghost"
              />
            )}
            {session.canArchive && (
              <SessionActionButton
                action="archive"
                onClick={() => archiveMutation.mutate({ sessionId: session.id })}
                isPending={archiveMutation.isPending}
                variant="ghost"
                sessionName={session.name}
              />
            )}
          </div>
        </div>
      </div>

      <div className="mt-2 text-xs text-muted-foreground">
        Last activity: {new Date(session.lastActivityAt).toLocaleString()}
      </div>
      <ActionErrorAlert error={error} onDismiss={dismiss} className="mt-2" />
    </li>
  );
}
