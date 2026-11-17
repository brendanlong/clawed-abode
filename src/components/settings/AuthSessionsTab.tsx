'use client';

import { useState } from 'react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { CenteredSpinner } from '@/components/ui/spinner';
import { AuthSessionListItem } from './AuthSessionListItem';
import { trpc } from '@/lib/trpc';

/**
 * Tab component for managing auth sessions.
 * Shows active sessions with ability to expire them, and a toggle to show expired sessions.
 */
export function AuthSessionsTab() {
  const [showInactive, setShowInactive] = useState(false);
  const query = trpc.auth.listSessions.useInfiniteQuery(
    {},
    { getNextPageParam: (lastPage) => lastPage.nextCursor }
  );
  const { isLoading, hasNextPage, isFetchingNextPage, fetchNextPage } = query;
  const sessions = query.data?.pages.flatMap((page) => page.sessions) ?? [];

  if (isLoading) {
    return <CenteredSpinner />;
  }

  const activeSessions = sessions.filter((s) => s.state === 'active');
  const inactiveSessions = sessions.filter((s) => s.state !== 'active');

  return (
    <div className="space-y-4">
      <Card>
        <CardHeader className="py-4">
          <CardTitle className="text-base">Active Sessions</CardTitle>
        </CardHeader>
        <CardContent className="p-0">
          {activeSessions.length > 0 ? (
            <ul className="divide-y divide-border">
              {activeSessions.map((session) => (
                <AuthSessionListItem key={session.id} session={session} />
              ))}
            </ul>
          ) : (
            <div className="p-6 text-center text-muted-foreground">No active sessions found.</div>
          )}
        </CardContent>
      </Card>

      {/* Pages are ordered by creation, so later pages are mostly inactive;
          only offer them once that section is visible. */}
      <div className="flex justify-center gap-2">
        <Button variant="ghost" size="sm" onClick={() => setShowInactive(!showInactive)}>
          {showInactive ? 'Hide inactive sessions' : 'Show inactive sessions'}
        </Button>
        {showInactive && hasNextPage && (
          <Button
            variant="ghost"
            size="sm"
            disabled={isFetchingNextPage}
            onClick={() => void fetchNextPage()}
          >
            {isFetchingNextPage ? 'Loading…' : 'Load more'}
          </Button>
        )}
      </div>

      {showInactive && inactiveSessions.length > 0 && (
        <Card>
          <CardHeader className="py-3">
            <CardTitle className="text-sm font-medium text-muted-foreground">
              Inactive Sessions
            </CardTitle>
          </CardHeader>
          <CardContent className="p-0">
            <ul className="divide-y divide-border">
              {inactiveSessions.map((session) => (
                <AuthSessionListItem key={session.id} session={session} />
              ))}
            </ul>
          </CardContent>
        </Card>
      )}

      {showInactive && inactiveSessions.length === 0 && (
        <div className="text-center text-sm text-muted-foreground">No inactive sessions</div>
      )}
    </div>
  );
}
