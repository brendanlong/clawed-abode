/**
 * GitHub lists branches alphabetically, so the default branch can land anywhere
 * (or past a page cap). Put it first so it's always present and easy to find.
 * An empty list stays empty: a repo with no commits has a default branch name
 * but no branch to clone.
 */
export function defaultBranchFirst(names: string[], defaultBranch: string): string[] {
  if (names.length === 0) return names;
  return [defaultBranch, ...names.filter((name) => name !== defaultBranch)];
}
