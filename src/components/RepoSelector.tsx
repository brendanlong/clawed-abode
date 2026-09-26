'use client';

import { useMemo, useState } from 'react';
import { trpc } from '@/lib/trpc';
import { resolveListQueryState } from '@/lib/list-query-state';
import { Label } from '@/components/ui/label';
import { Input } from '@/components/ui/input';
import { Spinner } from '@/components/ui/spinner';
import { cn } from '@/lib/utils';
import { Star, FolderOpen } from 'lucide-react';
import { buildRepoChoices } from '@/lib/repo-list';

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

const NO_REPO_SEARCH_TEXT = 'No Repository workspace';

/** Synthetic Repo entry representing "No Repository" */
const NO_REPO_ENTRY: Repo = {
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

  const { data, isLoading, error } = trpc.github.listRepos.useQuery(undefined, {
    // Listing walks every GitHub page; don't redo it on every tab focus.
    staleTime: 5 * 60 * 1000,
  });

  // Fetch favorites to sort repos and show star icons
  const { data: favoritesData } = trpc.repoSettings.listFavorites.useQuery();
  const favorites = useMemo(() => new Set(favoritesData?.favorites ?? []), [favoritesData]);

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

  const githubRepos = useMemo(() => data?.repos ?? [], [data]);

  // Counted on the GitHub repos alone: the synthetic "No Repository" entry is
  // always present, so including it would mask a failed query as a populated list.
  const state = resolveListQueryState({
    isLoading,
    hasError: !!error,
    itemCount: githubRepos.length,
  });

  const { matches: repos, total } = useMemo(
    () =>
      buildRepoChoices({
        repos: githubRepos,
        favorites,
        query: search,
        noRepoEntry: NO_REPO_ENTRY,
        noRepoSearchText: NO_REPO_SEARCH_TEXT,
        selectedFullName: selectedRepo?.fullName,
      }),
    [githubRepos, favorites, search, selectedRepo?.fullName]
  );
  const hiddenCount = total - repos.filter((r) => r.fullName !== NO_REPO_SENTINEL).length;

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

      {/* A banner rather than a replacement for the list: when GitHub is
          unreachable the synthetic "No Repository" entry is still a valid
          choice, so the user keeps a way forward. */}
      {state === 'error' && (
        <p className="text-sm text-destructive">Could not load repositories: {error?.message}</p>
      )}

      <div className="border rounded-lg max-h-64 overflow-y-auto">
        {state === 'loading' ? (
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
            {(hiddenCount > 0 || data?.truncated) && (
              <li className="px-4 py-3 text-xs text-muted-foreground">
                {hiddenCount > 0
                  ? `${hiddenCount.toLocaleString()} more repositories match. Keep typing to narrow the list.`
                  : 'You have access to more repositories than can be listed; some are missing.'}
              </li>
            )}
          </ul>
        )}
      </div>
    </div>
  );
}
