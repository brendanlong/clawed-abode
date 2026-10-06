import type { inferRouterInputs } from '@trpc/server';
import type { AppRouter } from '@/server/routers';
import type { Repo } from '@/components/RepoSelector';
import { NO_REPO_SENTINEL } from '@/lib/repo-full-name';
import { SESSION_NAME_MAX_LENGTH } from '@/lib/types';
import type { FormState } from './form-reducer';

type CreateSessionInput = inferRouterInputs<AppRouter>['sessions']['create'];

/**
 * The branch the session will use: the user's pick, else the repo's default once
 * branches have loaded. An empty repo lists no branches and so has none to use.
 */
export function resolveBranch(
  selectedBranch: string,
  branchList: { branches: string[]; defaultBranch: string } | undefined
): string {
  if (selectedBranch) return selectedBranch;
  return branchList && branchList.branches.length > 0 ? branchList.defaultBranch : '';
}

/** The name used when the user leaves the session name blank. */
export function defaultSessionName(repo: Repo, branch: string): string {
  const name = repo.fullName === NO_REPO_SENTINEL ? 'Workspace' : `${repo.name} - ${branch}`;
  return name.slice(0, SESSION_NAME_MAX_LENGTH);
}

/**
 * The `sessions.create` input for the form and its resolved branch, or null while
 * the form can't be submitted (no repo choice yet, or a repo with no branch).
 */
export function buildCreateSessionInput(
  form: FormState,
  branch: string
): CreateSessionInput | null {
  const repo = form.selectedRepo;
  if (!repo) return null;

  const isNoRepo = repo.fullName === NO_REPO_SENTINEL;
  if (!isNoRepo && !branch) return null;

  return {
    name: form.sessionName || defaultSessionName(repo, branch),
    repoFullName: isNoRepo ? undefined : repo.fullName,
    branch: isNoRepo ? undefined : branch,
    initialPrompt: form.initialPrompt.trim() || undefined,
    claudeModel: form.claudeModel?.trim() || undefined,
  };
}
