'use client';

import { useState } from 'react';
import { trpc } from '@/lib/trpc';
import { resolveListQueryState } from '@/lib/list-query-state';
import { Label } from '@/components/ui/label';
import { Input } from '@/components/ui/input';
import { Spinner } from '@/components/ui/spinner';
import { Badge } from '@/components/ui/badge';
import { SelectableRowButton } from '@/components/SelectableRowButton';
import type { Issue } from '@/lib/types';
import { useInfiniteScroll } from '@/hooks/useInfiniteScroll';
import { useDebounce } from '@/hooks/useDebounce';

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
  const debouncedSearch = useDebounce(search, 300);

  const {
    data,
    isLoading,
    error,
    fetchNextPage,
    hasNextPage,
    isFetchingNextPage,
    isFetchNextPageError,
  } = trpc.github.listIssues.useInfiniteQuery(
    { repoFullName, search: debouncedSearch || undefined, perPage: 15 },
    {
      getNextPageParam: (lastPage) => lastPage.nextCursor,
      enabled: !!repoFullName,
    }
  );

  const issues = data?.pages.flatMap((p) => p.issues) || [];
  const state = resolveListQueryState({ isLoading, hasError: !!error, itemCount: issues.length });

  const { rootRef, sentinelRef } = useInfiniteScroll({
    hasMore: hasNextPage ?? false,
    isLoading: isFetchingNextPage,
    loadFailed: isFetchNextPageError,
    onLoadMore: () => void fetchNextPage(),
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

      <div ref={rootRef} className="border rounded-lg max-h-48 overflow-y-auto">
        {state === 'loading' ? (
          <div className="flex justify-center py-6">
            <Spinner />
          </div>
        ) : state === 'error' ? (
          <div className="text-center py-6 text-destructive text-sm px-4">
            Could not load issues: {error?.message}
          </div>
        ) : state === 'empty' ? (
          <div className="text-center py-6 text-muted-foreground text-sm">
            {search ? 'No issues found' : 'No open issues'}
          </div>
        ) : (
          <ul className="divide-y divide-border">
            {selectedIssue && (
              <li>
                <SelectableRowButton
                  onClick={() => onSelect(null)}
                  className="px-4 py-2 bg-muted/30 text-sm text-muted-foreground"
                >
                  Clear selection
                </SelectableRowButton>
              </li>
            )}
            {issues.map((issue) => (
              <li key={issue.id}>
                <SelectableRowButton
                  selected={selectedIssue?.id === issue.id}
                  onClick={() => onSelect(issue)}
                  className="flex items-start gap-2 px-4 py-2"
                >
                  <span className="text-xs text-muted-foreground shrink-0">#{issue.number}</span>
                  <span className="block flex-1 min-w-0">
                    <span className="block text-sm font-medium truncate">{issue.title}</span>
                    <span className="flex flex-wrap gap-1 mt-1">
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
                    </span>
                  </span>
                </SelectableRowButton>
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
