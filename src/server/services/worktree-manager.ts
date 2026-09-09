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
  GITHUB_CREDENTIAL_HELPER_KEY,
  buildGithubCredentialHelper,
  writeGithubToken,
} from './github-credentials';

const log = createLogger('worktree-manager');

/** Base directory for session workspaces */
const WORKTREES_DIR = join(homedir(), 'worktrees');

/**
 * Run a command, rejecting with its stderr. The failure message includes the
 * argv, so callers must keep secrets out of it (see `github-credentials.ts`).
 */
function run(command: string, args: string[], options: { cwd?: string } = {}): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(
      command,
      args,
      {
        ...options,
        maxBuffer: 10 * 1024 * 1024,
        // Never block on a credential prompt: a bad token must fail, not hang.
        env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
      },
      (err, stdout, stderr) => {
        if (err) {
          const msg = `${command} ${args.join(' ')} failed: ${stderr || err.message}`;
          reject(new Error(msg));
          return;
        }
        resolve(stdout);
      }
    );
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

  // The token is never embedded in the URL or the helper: both would put it on
  // git's argv and in `.git/config`. It goes to a mode-0600 file the helper reads.
  const credentialHelper = githubToken
    ? buildGithubCredentialHelper(await writeGithubToken(workspacePath, githubToken))
    : null;
  const credentialArgs = credentialHelper
    ? ['-c', `${GITHUB_CREDENTIAL_HELPER_KEY}=${credentialHelper}`]
    : [];

  await run('git', [
    ...credentialArgs,
    'clone',
    '--branch',
    branch,
    '--single-branch',
    `https://github.com/${repoFullName}.git`,
    clonePath,
  ]);

  // Widen fetch refspec to track all remote branches
  await run('git', [
    '-C',
    clonePath,
    'config',
    'remote.origin.fetch',
    '+refs/heads/*:refs/remotes/origin/*',
  ]);

  // Persist the helper so the agent's own pushes authenticate too
  if (credentialHelper) {
    await run('git', ['-C', clonePath, 'config', GITHUB_CREDENTIAL_HELPER_KEY, credentialHelper]);
  }

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
