'use client';

import Link from 'next/link';
import { trpc } from '@/lib/trpc';
import { extractRepoFullName } from '@/lib/utils';
import { SessionStatusBadge } from '@/components/SessionStatusBadge';
import { SessionActionButton } from '@/components/SessionActionButton';
import { PrStatusIndicator } from '@/components/PrStatusIndicator';
import { usePullRequestStatus } from '@/hooks/usePullRequestStatus';
import type { Session } from '@/hooks/useSessionList';

export interface SessionListItemProps {
  session: Session;
  onMutationSuccess?: () => void;
}

/**
 * Session list item that owns its own mutation state.
 * Each instance tracks its own pending start/stop/archive independently.
 */
export function SessionListItem({ session, onMutationSuccess }: SessionListItemProps) {
  const repoName = extractRepoFullName(session.repoUrl);
  const isArchived = session.status === 'archived';

  const startMutation = trpc.sessions.start.useMutation({ onSuccess: onMutationSuccess });
  const stopMutation = trpc.sessions.stop.useMutation({ onSuccess: onMutationSuccess });
  const archiveMutation = trpc.sessions.delete.useMutation({ onSuccess: onMutationSuccess });

  const { pullRequest } = usePullRequestStatus(
    session.id,
    session.repoUrl,
    session.branch,
    !isArchived
  );

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
              {repoName}
              <span className="mx-1">·</span>
              {session.branch}
            </p>
          </Link>
        </div>

        <div className="flex items-center gap-4">
          {pullRequest && <PrStatusIndicator pullRequest={pullRequest} />}
          <SessionStatusBadge status={session.status} />

          <div className="flex items-center gap-2">
            {/* No controls for archived sessions - they're read-only */}
            {!isArchived && (
              <>
                {session.status === 'stopped' && (
                  <SessionActionButton
                    action="start"
                    onClick={() => startMutation.mutate({ sessionId: session.id })}
                    isPending={startMutation.isPending}
                    variant="ghost"
                  />
                )}
                {session.status === 'running' && (
                  <SessionActionButton
                    action="stop"
                    onClick={() => stopMutation.mutate({ sessionId: session.id })}
                    isPending={stopMutation.isPending}
                    variant="ghost"
                  />
                )}
                <SessionActionButton
                  action="archive"
                  onClick={() => archiveMutation.mutate({ sessionId: session.id })}
                  isPending={archiveMutation.isPending}
                  variant="ghost"
                  sessionName={session.name}
                />
              </>
            )}
          </div>
        </div>
      </div>

      <div className="mt-2 text-xs text-muted-foreground">
        Last updated: {new Date(session.updatedAt).toLocaleString()}
      </div>
    </li>
  );
}
