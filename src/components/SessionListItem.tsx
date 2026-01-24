'use client';

import { useState } from 'react';
import Link from 'next/link';
import { trpc } from '@/lib/trpc';
import { Button } from '@/components/ui/button';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from '@/components/ui/alert-dialog';
import { SessionStatusBadge } from '@/components/SessionStatusBadge';
import { Spinner } from '@/components/ui/spinner';

interface Session {
  id: string;
  name: string;
  repoUrl: string;
  branch: string;
  status: string;
  updatedAt: Date;
}

interface SessionListItemProps {
  session: Session;
  onMutationSuccess: () => void;
}

export function SessionListItem({ session, onMutationSuccess }: SessionListItemProps) {
  const [archiveDialogOpen, setArchiveDialogOpen] = useState(false);

  const startMutation = trpc.sessions.start.useMutation({
    onSuccess: onMutationSuccess,
  });

  const stopMutation = trpc.sessions.stop.useMutation({
    onSuccess: onMutationSuccess,
  });

  const archiveMutation = trpc.sessions.delete.useMutation({
    onSuccess: () => {
      setArchiveDialogOpen(false);
      onMutationSuccess();
    },
  });

  const repoName = session.repoUrl.replace('https://github.com/', '').replace('.git', '');

  const isArchiving = archiveMutation.isPending;
  const isArchived = session.status === 'archived';

  return (
    <li
      className={`p-4 hover:bg-muted/50 transition-all ${isArchiving ? 'opacity-50 pointer-events-none' : ''}`}
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
          <SessionStatusBadge status={session.status} />

          <div className="flex items-center gap-2">
            {/* No controls for archived sessions - they're read-only */}
            {!isArchived && (
              <>
                {session.status === 'stopped' && (
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={() => startMutation.mutate({ sessionId: session.id })}
                    disabled={startMutation.isPending}
                  >
                    {startMutation.isPending ? 'Starting...' : 'Start'}
                  </Button>
                )}
                {session.status === 'running' && (
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={() => stopMutation.mutate({ sessionId: session.id })}
                    disabled={stopMutation.isPending}
                  >
                    {stopMutation.isPending ? 'Stopping...' : 'Stop'}
                  </Button>
                )}
                {isArchiving ? (
                  <Button variant="ghost" size="sm" disabled className="text-muted-foreground">
                    <Spinner size="sm" className="mr-2" />
                    Archiving...
                  </Button>
                ) : (
                  <AlertDialog open={archiveDialogOpen} onOpenChange={setArchiveDialogOpen}>
                    <AlertDialogTrigger asChild>
                      <Button variant="ghost" size="sm" className="text-muted-foreground">
                        Archive
                      </Button>
                    </AlertDialogTrigger>
                    <AlertDialogContent>
                      <AlertDialogHeader>
                        <AlertDialogTitle>Archive session?</AlertDialogTitle>
                        <AlertDialogDescription>
                          This will archive the session &quot;{session.name}&quot; and remove its
                          workspace. You can still view the message history in archived sessions.
                        </AlertDialogDescription>
                      </AlertDialogHeader>
                      <AlertDialogFooter>
                        <AlertDialogCancel>Cancel</AlertDialogCancel>
                        <AlertDialogAction
                          onClick={() => archiveMutation.mutate({ sessionId: session.id })}
                        >
                          Archive
                        </AlertDialogAction>
                      </AlertDialogFooter>
                    </AlertDialogContent>
                  </AlertDialog>
                )}
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
