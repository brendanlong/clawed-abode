import { capMatches, matchesAllTerms, type CappedMatches } from './search';

/** Most GitHub repos the picker renders at once. */
export const REPO_PICKER_LIMIT = 100;

interface RepoLike {
  fullName: string;
}

/**
 * The repo picker's rows for `query`: favorites first (in their fetched order),
 * then the rest, with the synthetic no-repo entry at the top when it's a
 * favorite and otherwise just after the favorites. The cap applies to the
 * GitHub repos, keeping `selectedFullName` visible.
 */
export function buildRepoChoices<R extends RepoLike>({
  repos,
  favorites,
  query,
  noRepoEntry,
  noRepoSearchText,
  selectedFullName,
  limit = REPO_PICKER_LIMIT,
}: {
  repos: readonly R[];
  favorites: ReadonlySet<string>;
  query: string;
  noRepoEntry: R;
  noRepoSearchText: string;
  selectedFullName?: string;
  limit?: number;
}): CappedMatches<R> {
  const matching = repos.filter((r) => matchesAllTerms(r.fullName, query));
  const ordered = [
    ...matching.filter((r) => favorites.has(r.fullName)),
    ...matching.filter((r) => !favorites.has(r.fullName)),
  ];
  const capped = capMatches(ordered, limit, (r) => r.fullName === selectedFullName);
  // A pinned selection lands at index 0; move it back behind the favorites.
  const matches = [
    ...capped.matches.filter((r) => favorites.has(r.fullName)),
    ...capped.matches.filter((r) => !favorites.has(r.fullName)),
  ];
  const { total } = capped;

  if (!matchesAllTerms(noRepoSearchText, query)) return { matches, total };

  const insertAt = favorites.has(noRepoEntry.fullName)
    ? 0
    : matches.filter((r) => favorites.has(r.fullName)).length;
  return {
    matches: [...matches.slice(0, insertAt), noRepoEntry, ...matches.slice(insertAt)],
    total,
  };
}
