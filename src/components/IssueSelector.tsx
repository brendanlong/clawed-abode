'use client';

import { useState, useEffect } from 'react';
import { trpc } from '@/lib/trpc';
import { Label } from '@/components/ui/label';
import { Input } from '@/components/ui/input';
import { Spinner } from '@/components/ui/spinner';
import { Badge } from '@/components/ui/badge';
import { cn } from '@/lib/utils';
import type { Issue } from '@/lib/types';
import { useInfiniteScroll } from '@/hooks/useInfiniteScroll';

export function IssueSelector({
  repoFullName,
  selectedIssue,
  onSelect,
}: {
  repoFullName: string;
  selectedIssue: Issue | null;
  onSelect: (issue: Issue | null) => void;
}) {
  const [search, setSearch] = useState('');
  const [debouncedSearch, setDebouncedSearch] = useState('');

  useEffect(() => {
    const timer = setTimeout(() => setDebouncedSearch(search), 300);
    return () => clearTimeout(timer);
  }, [search]);

  const { data, isLoading, fetchNextPage, hasNextPage, isFetchingNextPage } =
    trpc.github.listIssues.useInfiniteQuery(
      { repoFullName, search: debouncedSearch || undefined, perPage: 15 },
      {
        getNextPageParam: (lastPage) => lastPage.nextCursor,
        enabled: !!repoFullName,
      }
    );

  const issues = data?.pages.flatMap((p) => p.issues) || [];

  const { scrollRef, sentinelRef } = useInfiniteScroll({
    hasNextPage: hasNextPage ?? false,
    isFetchingNextPage,
    fetchNextPage,
  });

  return (
    <div className="space-y-4">
      <div className="space-y-2">
        <Label>Link to GitHub issue (optional)</Label>
        <Input
          type="text"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="Search issues..."
        />
      </div>

      <div ref={scrollRef} className="border rounded-lg max-h-48 overflow-y-auto">
        {isLoading ? (
          <div className="flex justify-center py-6">
            <Spinner />
          </div>
        ) : issues.length === 0 ? (
          <div className="text-center py-6 text-muted-foreground text-sm">
            {search ? 'No issues found' : 'No open issues'}
          </div>
        ) : (
          <ul className="divide-y divide-border">
            {selectedIssue && (
              <li
                onClick={() => onSelect(null)}
                className="px-4 py-2 cursor-pointer hover:bg-muted/50 transition-colors bg-muted/30"
              >
                <div className="flex items-center gap-2 text-sm text-muted-foreground">
                  <span>Clear selection</span>
                </div>
              </li>
            )}
            {issues.map((issue) => (
              <li
                key={issue.id}
                onClick={() => onSelect(issue)}
                className={cn(
                  'px-4 py-2 cursor-pointer hover:bg-muted/50 transition-colors',
                  selectedIssue?.id === issue.id && 'bg-primary/10'
                )}
              >
                <div className="flex items-start gap-2">
                  <span className="text-xs text-muted-foreground shrink-0">#{issue.number}</span>
                  <div className="flex-1 min-w-0">
                    <p className="text-sm font-medium truncate">{issue.title}</p>
                    <div className="flex flex-wrap gap-1 mt-1">
                      {issue.labels.slice(0, 3).map((label) => (
                        <Badge
                          key={label.name}
                          variant="outline"
                          className="text-xs py-0"
                          style={{
                            borderColor: `#${label.color}`,
                            color: `#${label.color}`,
                          }}
                        >
                          {label.name}
                        </Badge>
                      ))}
                    </div>
                  </div>
                </div>
              </li>
            ))}
            {hasNextPage && (
              <li ref={sentinelRef} className="px-4 py-2 flex justify-center">
                <Spinner size="sm" />
              </li>
            )}
          </ul>
        )}
      </div>
    </div>
  );
}
