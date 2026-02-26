'use client';

import { useState } from 'react';
import { trpc } from '@/lib/trpc';
import { Label } from '@/components/ui/label';
import { Input } from '@/components/ui/input';
import { Spinner } from '@/components/ui/spinner';
import { cn } from '@/lib/utils';
import { Star, FolderOpen } from 'lucide-react';
import { useInfiniteScroll } from '@/hooks/useInfiniteScroll';
import { useDebounce } from '@/hooks/useDebounce';

export const NO_REPO_SENTINEL = '__no_repo__';

export interface Repo {
  id: number;
  fullName: string;
  name: string;
  owner: string;
  description: string | null;
  private: boolean;
  defaultBranch: string;
}

/** Synthetic Repo entry representing "No Repository" */
export const NO_REPO_ENTRY: Repo = {
  id: -1,
  fullName: NO_REPO_SENTINEL,
  name: 'No Repository',
  owner: '',
  description: 'Start a session with an empty workspace (no git clone)',
  private: false,
  defaultBranch: '',
};

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

  const isNoRepoFavorite = favorites.has(NO_REPO_SENTINEL);

  // Filter "no repo" entry by search
  const showNoRepo =
    !debouncedSearch ||
    'no repository'.includes(debouncedSearch.toLowerCase()) ||
    'workspace'.includes(debouncedSearch.toLowerCase());

  // Sort repos with favorites first, and insert the no-repo entry
  const sortedRepos = [...rawRepos].sort((a, b) => {
    const aFav = favorites.has(a.fullName);
    const bFav = favorites.has(b.fullName);
    if (aFav && !bFav) return -1;
    if (!aFav && bFav) return 1;
    return 0;
  });

  // Build final list: insert no-repo entry at the right position
  const repos: Repo[] = [];
  if (showNoRepo) {
    if (isNoRepoFavorite) {
      // If favorited, put it at the very top (above all repos)
      repos.push(NO_REPO_ENTRY);
    }
  }
  // Add all sorted GitHub repos
  repos.push(...sortedRepos);
  // If no-repo is not favorited but should be shown, add after favorites but above non-favorites
  if (showNoRepo && !isNoRepoFavorite) {
    const firstNonFavIndex = repos.findIndex((r) => !favorites.has(r.fullName));
    if (firstNonFavIndex === -1) {
      repos.push(NO_REPO_ENTRY);
    } else {
      repos.splice(firstNonFavIndex, 0, NO_REPO_ENTRY);
    }
  }

  const { scrollRef, sentinelRef } = useInfiniteScroll({
    hasNextPage: hasNextPage ?? false,
    isFetchingNextPage,
    fetchNextPage,
  });

  const isSelected = (repo: Repo) => {
    if (repo.fullName === NO_REPO_SENTINEL) {
      return selectedRepo?.fullName === NO_REPO_SENTINEL;
    }
    return selectedRepo?.id === repo.id;
  };

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
              const isNoRepo = repo.fullName === NO_REPO_SENTINEL;
              const isFavorite = favorites.has(repo.fullName);
              return (
                <li
                  key={repo.fullName}
                  onClick={() => onSelect(repo)}
                  className={cn(
                    'px-4 py-3 cursor-pointer hover:bg-muted/50 transition-colors',
                    isSelected(repo) && 'bg-primary/10'
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
                      {isNoRepo ? (
                        <div className="flex items-center gap-2">
                          <FolderOpen className="h-4 w-4 text-muted-foreground shrink-0" />
                          <div>
                            <p className="text-sm font-medium">No Repository (workspace only)</p>
                            <p className="text-xs text-muted-foreground">{repo.description}</p>
                          </div>
                        </div>
                      ) : (
                        <>
                          <p className="text-sm font-medium">{repo.fullName}</p>
                          {repo.description && (
                            <p className="text-xs text-muted-foreground truncate max-w-md">
                              {repo.description}
                            </p>
                          )}
                        </>
                      )}
                    </div>
                    {!isNoRepo && repo.private && (
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
