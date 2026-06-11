/**
 * Interactive pickers for the new-session flow: repo (favorites first),
 * branch, and optional GitHub issue (which prefills name + initial prompt).
 */

import { search, select, confirm } from '@inquirer/prompts';
import { env } from '@/lib/env';
import { NO_REPO_SENTINEL } from '@/lib/types';
import { listRepos, listBranches, listIssues, type IssueSummary } from '@/server/services/github';
import { listConfiguredRepos } from './settings';

interface PickerChoice<T> {
  name: string;
  value: T;
  description?: string;
}

/**
 * Pick a repository. Returns null for a no-repo (workspace only) session.
 */
export async function pickRepo(options?: {
  /** Include the "No Repository" choice (on for new sessions, off for settings) */
  allowNoRepo?: boolean;
}): Promise<string | null> {
  const allowNoRepo = options?.allowNoRepo ?? true;
  const token = env.GITHUB_TOKEN;
  const configured = await listConfiguredRepos();
  const favorites = configured.filter((repo) => repo.isFavorite);

  const staticChoices: PickerChoice<string | null>[] = [];
  for (const favorite of favorites) {
    if (favorite.repoFullName === NO_REPO_SENTINEL) continue;
    staticChoices.push({ name: `★ ${favorite.repoFullName}`, value: favorite.repoFullName });
  }
  if (allowNoRepo) {
    staticChoices.push({ name: 'No Repository (workspace only)', value: null });
  }

  return search<string | null>({
    message: 'Repository:',
    source: async (term) => {
      if (!token) {
        // Without a GitHub token we can only offer configured repos
        const filtered = staticChoices.filter(
          (choice) => !term || choice.name.toLowerCase().includes(term.toLowerCase())
        );
        return filtered;
      }

      const result = await listRepos({ search: term || undefined, perPage: 20 }, token);
      const fromGitHub: PickerChoice<string | null>[] = result.repos
        .filter((repo) => !favorites.some((f) => f.repoFullName === repo.fullName))
        .map((repo) => ({
          name: repo.fullName,
          value: repo.fullName,
          description: repo.description ?? undefined,
        }));

      const matchingStatic = staticChoices.filter(
        (choice) => !term || choice.name.toLowerCase().includes(term.toLowerCase())
      );
      return [...matchingStatic, ...fromGitHub];
    },
  });
}

/**
 * Pick a branch for a repository (default branch preselected at the top).
 */
export async function pickBranch(repoFullName: string): Promise<string> {
  const token = env.GITHUB_TOKEN;
  if (!token) {
    throw new Error('GITHUB_TOKEN is not configured; cannot list branches');
  }

  const { branches, defaultBranch } = await listBranches(repoFullName, token);
  const sorted = [
    ...branches.filter((b) => b.name === defaultBranch),
    ...branches.filter((b) => b.name !== defaultBranch),
  ];

  return search<string>({
    message: 'Branch:',
    source: (term) =>
      sorted
        .filter((b) => !term || b.name.toLowerCase().includes(term.toLowerCase()))
        .map((b) => ({
          name: b.name === defaultBranch ? `${b.name} (default)` : b.name,
          value: b.name,
        })),
  });
}

/**
 * Optionally pick an open issue to work on. Returns null when skipped.
 */
export async function pickIssue(repoFullName: string): Promise<IssueSummary | null> {
  const token = env.GITHUB_TOKEN;
  if (!token) return null;

  const startFromIssue = await confirm({
    message: 'Start from a GitHub issue?',
    default: false,
  });
  if (!startFromIssue) return null;

  return search<IssueSummary | null>({
    message: 'Issue:',
    source: async (term) => {
      const result = await listIssues(
        { repoFullName, search: term || undefined, perPage: 20 },
        token
      );
      const choices: PickerChoice<IssueSummary | null>[] = result.issues.map((issue) => ({
        name: `#${issue.number} ${issue.title}`,
        value: issue,
        description: issue.labels.map((l) => l.name).join(', ') || undefined,
      }));
      return [...choices, { name: '(skip)', value: null }];
    },
  });
}

/**
 * Pick a repo for settings editing: configured repos plus the no-repo
 * sentinel, with GitHub search for repos that have no settings yet.
 */
export async function pickSettingsRepo(): Promise<string | null> {
  const choices: PickerChoice<string | null>[] = (await listConfiguredRepos()).map((repo) => ({
    name:
      repo.repoFullName === NO_REPO_SENTINEL
        ? `${repo.isFavorite ? '★ ' : ''}No Repository (workspace sessions)`
        : `${repo.isFavorite ? '★ ' : ''}${repo.repoFullName}`,
    value: repo.repoFullName,
  }));

  if (!choices.some((choice) => choice.value === NO_REPO_SENTINEL)) {
    choices.push({ name: 'No Repository (workspace sessions)', value: NO_REPO_SENTINEL });
  }

  const fromList = await select<string | null>({
    message: 'Repository settings to edit:',
    choices: [
      ...choices,
      { name: 'Search GitHub...', value: '__search__' },
      { name: '(back)', value: null },
    ],
  });

  if (fromList === '__search__') {
    return pickRepo({ allowNoRepo: false });
  }
  return fromList;
}
