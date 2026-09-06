'use client';

import Link from 'next/link';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Spinner } from '@/components/ui/spinner';
import { SessionListItem } from '@/components/SessionListItem';
import { useInfiniteScroll } from '@/hooks/useInfiniteScroll';
import type { PagedSessions } from '@/hooks/useSessionList';

export interface SessionListProps {
  active: PagedSessions;
  archived: PagedSessions;
  showArchived: boolean;
  onToggleArchived: () => void;
}

/** One paginated list of sessions; loads the next page as the sentinel scrolls into view. */
function SessionListSection({ sessions, hasMore, isFetchingMore, fetchMore }: PagedSessions) {
  const { sentinelRef } = useInfiniteScroll({
    hasNextPage: hasMore,
    isFetchingNextPage: isFetchingMore,
    fetchNextPage: fetchMore,
  });

  return (
    <ul className="divide-y divide-border">
      {sessions.map((session) => (
        <SessionListItem key={session.id} session={session} />
      ))}
      {hasMore && (
        <li ref={sentinelRef} className="p-4 flex justify-center">
          {isFetchingMore ? (
            <Spinner size="sm" />
          ) : (
            <Button variant="ghost" size="sm" onClick={fetchMore}>
              Load more
            </Button>
          )}
        </li>
      )}
    </ul>
  );
}

/**
 * Pure presentation component for the home page's session lists.
 * Receives data and actions as props, making it easily testable.
 */
export function SessionList({
  active,
  archived,
  showArchived,
  onToggleArchived,
}: SessionListProps) {
  if (active.isLoading) {
    return (
      <div className="flex justify-center py-12">
        <Spinner size="lg" />
      </div>
    );
  }

  if (active.sessions.length === 0 && !showArchived) {
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
          <Button variant="ghost" size="sm" onClick={onToggleArchived}>
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
          {active.sessions.length > 0 ? (
            <SessionListSection {...active} />
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

      <div className="flex justify-center">
        <Button variant="ghost" size="sm" onClick={onToggleArchived}>
          {showArchived ? 'Hide archived sessions' : 'Show archived sessions'}
        </Button>
      </div>

      {showArchived && archived.isLoading && (
        <div className="flex justify-center py-4">
          <Spinner size="sm" />
        </div>
      )}

      {showArchived && !archived.isLoading && archived.sessions.length > 0 && (
        <Card>
          <CardHeader className="py-3">
            <CardTitle className="text-sm font-medium text-muted-foreground">
              Archived Sessions
            </CardTitle>
          </CardHeader>
          <CardContent className="p-0">
            <SessionListSection {...archived} />
          </CardContent>
        </Card>
      )}

      {showArchived && !archived.isLoading && archived.sessions.length === 0 && (
        <div className="text-center text-sm text-muted-foreground">No archived sessions</div>
      )}
    </div>
  );
}
