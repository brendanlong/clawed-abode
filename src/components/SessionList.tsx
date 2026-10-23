'use client';

import Link from 'next/link';
import { Button } from '@/components/ui/button';
import { Search } from 'lucide-react';
import { Input } from '@/components/ui/input';
import { cn } from '@/lib/utils';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { CenteredSpinner, Spinner } from '@/components/ui/spinner';
import { SessionListItem } from '@/components/SessionListItem';
import { useInfiniteScroll } from '@/hooks/useInfiniteScroll';
import type { PagedSessions } from '@/hooks/useSessionList';
import { SESSION_SEARCH_MAX_LENGTH } from '@/lib/types';

export interface SessionListProps {
  active: PagedSessions;
  archived: PagedSessions;
  showArchived: boolean;
  onToggleArchived: () => void;
  search: string;
  onSearchChange: (search: string) => void;
  /** The lists are currently filtered by a search (which may lag `search` while typing). */
  filtered: boolean;
}

function staleClass(list: PagedSessions) {
  return list.isStale ? 'opacity-50 transition-opacity' : undefined;
}

/** One paginated list of sessions; loads the next page as the sentinel scrolls into view. */
function SessionListSection({
  sessions,
  hasMore,
  isFetchingMore,
  loadFailed,
  fetchMore,
}: PagedSessions) {
  const { sentinelRef } = useInfiniteScroll({
    hasMore,
    isLoading: isFetchingMore,
    loadFailed,
    onLoadMore: fetchMore,
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
export function SessionList({ search, onSearchChange, ...lists }: SessionListProps) {
  return (
    <div className="space-y-4">
      <div className="relative">
        <Search className="absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
        <Input
          type="search"
          value={search}
          onChange={(e) => onSearchChange(e.target.value)}
          placeholder="Search sessions"
          aria-label="Search sessions"
          maxLength={SESSION_SEARCH_MAX_LENGTH}
          className="pl-9"
        />
      </div>
      <SessionLists {...lists} />
    </div>
  );
}

function SessionLists({
  active,
  archived,
  showArchived,
  onToggleArchived,
  filtered,
}: Omit<SessionListProps, 'search' | 'onSearchChange'>) {
  if (active.isLoading) {
    return <CenteredSpinner />;
  }

  if (active.sessions.length === 0 && !showArchived && !filtered) {
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
      <Card className={staleClass(active)}>
        <CardContent className="p-0">
          {active.sessions.length > 0 ? (
            <SessionListSection {...active} />
          ) : filtered ? (
            <div className="p-6 text-center text-muted-foreground">
              No active sessions match your search.
            </div>
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
        <Card className={staleClass(archived)}>
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
        <div className={cn('text-center text-sm text-muted-foreground', staleClass(archived))}>
          {filtered ? 'No archived sessions match your search' : 'No archived sessions'}
        </div>
      )}
    </div>
  );
}
