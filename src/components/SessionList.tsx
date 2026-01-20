'use client';

import { useState } from 'react';
import Link from 'next/link';
import { trpc } from '@/lib/trpc';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Spinner } from '@/components/ui/spinner';
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

export function SessionList() {
  const { data, isLoading, refetch } = trpc.sessions.list.useQuery();
  const [deletingId, setDeletingId] = useState<string | null>(null);

  const startMutation = trpc.sessions.start.useMutation({
    onSuccess: () => refetch(),
  });
  const stopMutation = trpc.sessions.stop.useMutation({
    onSuccess: () => refetch(),
  });
  const deleteMutation = trpc.sessions.delete.useMutation({
    onSuccess: () => {
      setDeletingId(null);
      refetch();
    },
  });

  if (isLoading) {
    return (
      <div className="flex justify-center py-12">
        <Spinner size="lg" />
      </div>
    );
  }

  const sessions = data?.sessions || [];

  if (sessions.length === 0) {
    return (
      <Card>
        <CardHeader className="text-center">
          <CardTitle>No sessions yet</CardTitle>
          <CardDescription>Get started by creating a new session.</CardDescription>
        </CardHeader>
        <CardContent className="flex justify-center">
          <Button asChild>
            <Link href="/new">New Session</Link>
          </Button>
        </CardContent>
      </Card>
    );
  }

  return (
    <Card>
      <CardContent className="p-0">
        <ul className="divide-y divide-border">
          {sessions.map((session) => (
            <li key={session.id} className="p-4 hover:bg-muted/50 transition-colors">
              <div className="flex items-center justify-between">
                <div className="flex-1 min-w-0">
                  <Link href={`/session/${session.id}`} className="block">
                    <p className="text-sm font-medium text-primary truncate hover:underline">
                      {session.name}
                    </p>
                    <p className="mt-1 text-sm text-muted-foreground truncate">
                      {session.repoUrl.replace('https://github.com/', '').replace('.git', '')}
                      <span className="mx-1">·</span>
                      {session.branch}
                    </p>
                  </Link>
                </div>

                <div className="flex items-center gap-4">
                  <SessionStatusBadge status={session.status} />

                  <div className="flex items-center gap-2">
                    {session.status === 'stopped' && (
                      <Button
                        variant="ghost"
                        size="sm"
                        onClick={() => startMutation.mutate({ sessionId: session.id })}
                        disabled={startMutation.isPending}
                      >
                        Start
                      </Button>
                    )}
                    {session.status === 'running' && (
                      <Button
                        variant="ghost"
                        size="sm"
                        onClick={() => stopMutation.mutate({ sessionId: session.id })}
                        disabled={stopMutation.isPending}
                      >
                        Stop
                      </Button>
                    )}
                    <AlertDialog
                      open={deletingId === session.id}
                      onOpenChange={(open) => setDeletingId(open ? session.id : null)}
                    >
                      <AlertDialogTrigger asChild>
                        <Button variant="ghost" size="sm" className="text-destructive">
                          Delete
                        </Button>
                      </AlertDialogTrigger>
                      <AlertDialogContent>
                        <AlertDialogHeader>
                          <AlertDialogTitle>Delete session?</AlertDialogTitle>
                          <AlertDialogDescription>
                            This will permanently delete the session &quot;{session.name}&quot; and
                            its workspace. This action cannot be undone.
                          </AlertDialogDescription>
                        </AlertDialogHeader>
                        <AlertDialogFooter>
                          <AlertDialogCancel>Cancel</AlertDialogCancel>
                          <AlertDialogAction
                            onClick={() => deleteMutation.mutate({ sessionId: session.id })}
                            className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
                          >
                            {deleteMutation.isPending ? 'Deleting...' : 'Delete'}
                          </AlertDialogAction>
                        </AlertDialogFooter>
                      </AlertDialogContent>
                    </AlertDialog>
                  </div>
                </div>
              </div>

              <div className="mt-2 text-xs text-muted-foreground">
                Last updated: {new Date(session.updatedAt).toLocaleString()}
              </div>
            </li>
          ))}
        </ul>
      </CardContent>
    </Card>
  );
}
