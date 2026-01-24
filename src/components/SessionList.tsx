'use client';

import { useState } from 'react';
import Link from 'next/link';
import { trpc } from '@/lib/trpc';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Spinner } from '@/components/ui/spinner';
import { SessionListItem } from '@/components/SessionListItem';

interface Session {
  id: string;
  name: string;
  repoUrl: string;
  branch: string;
  status: string;
  updatedAt: Date;
}

export function SessionList() {
  const [showArchived, setShowArchived] = useState(false);
  const { data, isLoading, refetch } = trpc.sessions.list.useQuery({
    includeArchived: showArchived,
  });

  if (isLoading) {
    return (
      <div className="flex justify-center py-12">
        <Spinner size="lg" />
      </div>
    );
  }

  const sessions: Session[] = data?.sessions ?? [];

  // Separate active and archived sessions for display
  const activeSessions = sessions.filter((s) => s.status !== 'archived');
  const archivedSessions = sessions.filter((s) => s.status === 'archived');

  if (sessions.length === 0 && !showArchived) {
    return (
      <Card>
        <CardHeader className="text-center">
          <CardTitle>No sessions yet</CardTitle>
          <CardDescription>Get started by creating a new session.</CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col items-center gap-4">
          <Button asChild>
            <Link href="/new">New Session</Link>
          </Button>
          <Button variant="ghost" size="sm" onClick={() => setShowArchived(true)}>
            Show archived sessions
          </Button>
        </CardContent>
      </Card>
    );
  }

  return (
    <div className="space-y-4">
      <Card>
        <CardContent className="p-0">
          {activeSessions.length > 0 ? (
            <ul className="divide-y divide-border">
              {activeSessions.map((session) => (
                <SessionListItem key={session.id} session={session} onMutationSuccess={refetch} />
              ))}
            </ul>
          ) : (
            <div className="p-6 text-center text-muted-foreground">
              No active sessions.{' '}
              <Link href="/new" className="text-primary hover:underline">
                Create one
              </Link>
            </div>
          )}
        </CardContent>
      </Card>

      {/* Toggle for archived sessions */}
      <div className="flex justify-center">
        <Button variant="ghost" size="sm" onClick={() => setShowArchived(!showArchived)}>
          {showArchived ? 'Hide archived sessions' : 'Show archived sessions'}
        </Button>
      </div>

      {/* Archived sessions section */}
      {showArchived && archivedSessions.length > 0 && (
        <Card>
          <CardHeader className="py-3">
            <CardTitle className="text-sm font-medium text-muted-foreground">
              Archived Sessions
            </CardTitle>
          </CardHeader>
          <CardContent className="p-0">
            <ul className="divide-y divide-border">
              {archivedSessions.map((session) => (
                <SessionListItem key={session.id} session={session} onMutationSuccess={refetch} />
              ))}
            </ul>
          </CardContent>
        </Card>
      )}

      {showArchived && archivedSessions.length === 0 && (
        <div className="text-center text-sm text-muted-foreground">No archived sessions</div>
      )}
    </div>
  );
}
