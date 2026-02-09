'use client';

import { useState } from 'react';
import { trpc } from '@/lib/trpc';
import { Label } from '@/components/ui/label';
import { Input } from '@/components/ui/input';
import { Spinner } from '@/components/ui/spinner';
import { cn } from '@/lib/utils';
import { Star } from 'lucide-react';
import { useInfiniteScroll } from '@/hooks/useInfiniteScroll';
import { useDebounce } from '@/hooks/useDebounce';

export interface Repo {
  id: number;
  fullName: string;
  name: string;
  owner: string;
  description: string | null;
  private: boolean;
  defaultBranch: string;
}

export function RepoSelector({
  selectedRepo,
  onSelect,
}: {
  selectedRepo: Repo | null;
  onSelect: (repo: Repo) => void;
}) {
  const [search, setSearch] = useState('');
  const debouncedSearch = useDebounce(search, 300);

  const { data, isLoading, fetchNextPage, hasNextPage, isFetchingNextPage } =
    trpc.github.listRepos.useInfiniteQuery(
      { search: debouncedSearch || undefined, perPage: 20 },
      {
        getNextPageParam: (lastPage) => lastPage.nextCursor,
      }
    );

  // Fetch favorites to sort repos and show star icons
  const { data: favoritesData } = trpc.repoSettings.listFavorites.useQuery();
  const favorites = new Set(favoritesData?.favorites ?? []);

  const toggleFavorite = trpc.repoSettings.toggleFavorite.useMutation();
  const utils = trpc.useUtils();

  const handleToggleFavorite = (e: React.MouseEvent, repoFullName: string) => {
    e.stopPropagation(); // Don't trigger repo selection
    const newIsFavorite = !favorites.has(repoFullName);
    toggleFavorite.mutate(
      { repoFullName, isFavorite: newIsFavorite },
      {
        onSuccess: () => {
          utils.repoSettings.listFavorites.invalidate();
        },
      }
    );
  };

  const rawRepos = data?.pages.flatMap((p) => p.repos) || [];

  // Sort repos with favorites first
  const repos = [...rawRepos].sort((a, b) => {
    const aFav = favorites.has(a.fullName);
    const bFav = favorites.has(b.fullName);
    if (aFav && !bFav) return -1;
    if (!aFav && bFav) return 1;
    return 0;
  });

  const { scrollRef, sentinelRef } = useInfiniteScroll({
    hasNextPage: hasNextPage ?? false,
    isFetchingNextPage,
    fetchNextPage,
  });

  return (
    <div className="space-y-4">
      <div className="space-y-2">
        <Label>Search repositories</Label>
        <Input
          type="text"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="Search your repositories..."
        />
      </div>

      <div ref={scrollRef} className="border rounded-lg max-h-64 overflow-y-auto">
        {isLoading ? (
          <div className="flex justify-center py-8">
            <Spinner />
          </div>
        ) : repos.length === 0 ? (
          <div className="text-center py-8 text-muted-foreground">No repositories found</div>
        ) : (
          <ul className="divide-y divide-border">
            {repos.map((repo) => {
              const isFavorite = favorites.has(repo.fullName);
              return (
                <li
                  key={repo.id}
                  onClick={() => onSelect(repo)}
                  className={cn(
                    'px-4 py-3 cursor-pointer hover:bg-muted/50 transition-colors',
                    selectedRepo?.id === repo.id && 'bg-primary/10'
                  )}
                >
                  <div className="flex items-center justify-between gap-2">
                    <button
                      type="button"
                      onClick={(e) => handleToggleFavorite(e, repo.fullName)}
                      className="p-1 hover:bg-muted rounded transition-colors shrink-0"
                      title={isFavorite ? 'Remove from favorites' : 'Add to favorites'}
                    >
                      <Star
                        className={cn(
                          'h-4 w-4',
                          isFavorite ? 'text-yellow-500 fill-yellow-500' : 'text-muted-foreground'
                        )}
                      />
                    </button>
                    <div className="flex-1 min-w-0">
                      <p className="text-sm font-medium">{repo.fullName}</p>
                      {repo.description && (
                        <p className="text-xs text-muted-foreground truncate max-w-md">
                          {repo.description}
                        </p>
                      )}
                    </div>
                    {repo.private && (
                      <span className="text-xs text-muted-foreground shrink-0">Private</span>
                    )}
                  </div>
                </li>
              );
            })}
            {hasNextPage && (
              <li ref={sentinelRef} className="px-4 py-3 flex justify-center">
                <Spinner size="sm" />
              </li>
            )}
          </ul>
        )}
      </div>
    </div>
  );
}
