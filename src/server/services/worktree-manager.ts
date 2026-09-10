/**
 * Manages git clones for session isolation.
 *
 * Each session gets its own git clone at ~/worktrees/{sessionId}/{repoName}.
 */

import { execFile } from 'child_process';
import { mkdir, rm } from 'fs/promises';
import { join } from 'path';
import { homedir } from 'os';
import { createLogger, toError } from '@/lib/logger';
import { env } from '@/lib/env';
import {
  GITHUB_CREDENTIAL_CONFIG_KEY,
  GITHUB_CREDENTIAL_HELPER,
  githubCredentialEnv,
} from '@/lib/git-credentials';

const log = createLogger('worktree-manager');

/** Base directory for session workspaces */
const WORKTREES_DIR = join(homedir(), 'worktrees');

function run(
  command: string,
  args: string[],
  options: { cwd?: string; env?: Record<string, string> } = {}
): Promise<string> {
  const { env: extraEnv, ...rest } = options;
  return new Promise((resolve, reject) => {
    const childOptions = {
      ...rest,
      env: { ...process.env, ...extraEnv },
      maxBuffer: 10 * 1024 * 1024,
    };
    execFile(command, args, childOptions, (err, stdout, stderr) => {
      if (err) {
        const msg = `${command} ${args.join(' ')} failed: ${stderr || err.message}`;
        reject(new Error(msg));
        return;
      }
      resolve(stdout);
    });
  });
}

export function getSessionWorkspacePath(sessionId: string): string {
  return join(WORKTREES_DIR, sessionId);
}

/**
 * Get the working directory for a session (the repo checkout inside the workspace).
 */
export function getSessionWorkingDir(sessionId: string, repoPath: string): string {
  if (!repoPath) {
    return getSessionWorkspacePath(sessionId);
  }
  return join(WORKTREES_DIR, sessionId, repoPath);
}

export interface CloneConfig {
  sessionId: string;
  repoFullName: string;
  branch: string;
  githubToken?: string;
}

export interface CloneResult {
  /** Relative path to repo within workspace (e.g., "my-repo") */
  repoPath: string;
  /** Absolute path to the cloned repo */
  workingDir: string;
}

/**
 * The `git clone` invocation for a repo, with credentials in the environment.
 * Pure so the no-secrets-in-argv rule is testable: nothing here may put the
 * token in `args`.
 */
export function buildCloneCommand(params: {
  repoFullName: string;
  branch: string;
  clonePath: string;
  githubToken?: string;
}): { args: string[]; env: Record<string, string> } {
  const { repoFullName, branch, clonePath, githubToken } = params;
  return {
    args: [
      'clone',
      '--branch',
      branch,
      '--single-branch',
      `https://github.com/${repoFullName}.git`,
      clonePath,
    ],
    env: {
      // Fail instead of blocking on a username prompt when auth is missing or rejected.
      GIT_TERMINAL_PROMPT: '0',
      ...(githubToken ? githubCredentialEnv(githubToken) : {}),
    },
  };
}

/**
 * Point a clone's credential helper at the environment. Idempotent, and
 * `--replace-all` collapses whatever was there before — which is how clones
 * made before this helper existed shed the plaintext token they persisted.
 */
export async function ensureGithubCredentialHelper(clonePath: string): Promise<void> {
  await run('git', [
    '-C',
    clonePath,
    'config',
    '--replace-all',
    GITHUB_CREDENTIAL_CONFIG_KEY,
    GITHUB_CREDENTIAL_HELPER,
  ]);
}

/**
 * Clone a repository for a session.
 *
 * Creates a fresh clone at /worktrees/{sessionId}/{repoName},
 * configures credentials, and creates a session-specific branch.
 */
export async function cloneRepo(config: CloneConfig): Promise<CloneResult> {
  const { sessionId, repoFullName, branch, githubToken } = config;
  const repoName = repoFullName.split('/')[1];
  const workspacePath = getSessionWorkspacePath(sessionId);
  const clonePath = join(workspacePath, repoName);

  log.info('Cloning repo', { sessionId, repoFullName, branch });

  await mkdir(workspacePath, { recursive: true });

  const clone = buildCloneCommand({ repoFullName, branch, clonePath, githubToken });
  await run('git', clone.args, { env: clone.env });

  // Widen fetch refspec to track all remote branches
  await run('git', [
    '-C',
    clonePath,
    'config',
    'remote.origin.fetch',
    '+refs/heads/*:refs/remotes/origin/*',
  ]);

  await ensureGithubCredentialHelper(clonePath);

  // Create and check out a session-specific branch
  const sessionBranch = `${env.SESSION_BRANCH_PREFIX}${sessionId}`;
  await run('git', ['-C', clonePath, 'checkout', '-b', sessionBranch]);

  log.info('Repo cloned successfully', { sessionId, repoName, branch: sessionBranch });

  return {
    repoPath: repoName,
    workingDir: clonePath,
  };
}

export async function createEmptyWorkspace(sessionId: string): Promise<string> {
  const workspacePath = getSessionWorkspacePath(sessionId);
  log.info('Creating empty workspace', { sessionId, workspacePath });
  await mkdir(workspacePath, { recursive: true });
  return workspacePath;
}

export async function removeWorkspace(sessionId: string): Promise<void> {
  const workspacePath = getSessionWorkspacePath(sessionId);
  log.info('Removing workspace', { sessionId, workspacePath });

  try {
    await rm(workspacePath, { recursive: true, force: true });
    log.info('Workspace removed', { sessionId });
  } catch (error) {
    log.error('Failed to remove workspace', toError(error), { sessionId });
  }
}

/**
 * Get the current git branch in a repo.
 * Returns null if the branch cannot be determined.
 */
export async function getCurrentBranch(workingDir: string): Promise<string | null> {
  try {
    const result = await run('git', ['symbolic-ref', '--short', 'HEAD'], { cwd: workingDir });
    return result.trim() || null;
  } catch {
    return null;
  }
}
