/**
 * Manages git worktrees for session isolation.
 *
 * Each session gets its own git worktree, created from a shared bare repo cache.
 * This provides filesystem isolation between sessions while sharing git objects
 * for fast setup.
 *
 * Directory layout:
 *   /repos/{owner}--{repo}.git    - bare repo cache (shared git objects)
 *   /worktrees/{sessionId}/{repo} - per-session worktrees
 */

import { execFile } from 'child_process';
import { mkdir, rm, access } from 'fs/promises';
import { join } from 'path';
import { createLogger, toError } from '@/lib/logger';
import { env } from '@/lib/env';

const log = createLogger('worktree-manager');

/** Base directory for bare repo caches */
const REPOS_DIR = '/repos';

/** Base directory for session worktrees */
const WORKTREES_DIR = '/worktrees';

/**
 * Run a command and return stdout.
 */
function run(
  command: string,
  args: string[],
  options: { cwd?: string; env?: NodeJS.ProcessEnv } = {}
): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(command, args, { ...options, maxBuffer: 10 * 1024 * 1024 }, (err, stdout, stderr) => {
      if (err) {
        const msg = `${command} ${args.join(' ')} failed: ${stderr || err.message}`;
        reject(new Error(msg));
        return;
      }
      resolve(stdout);
    });
  });
}

/**
 * Check if a path exists.
 */
async function pathExists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

/**
 * Convert a repo full name (e.g., "owner/repo") to a bare repo cache path.
 */
function bareRepoPath(repoFullName: string): string {
  return join(REPOS_DIR, `${repoFullName.replace('/', '--')}.git`);
}

/**
 * Get the workspace directory for a session.
 */
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

/**
 * Update or create a bare repo cache for a repository.
 * If the cache exists, fetches latest refs. Otherwise clones a new bare repo.
 *
 * @returns true if cache is ready, false if caching failed
 */
async function updateBareRepoCache(repoFullName: string, githubToken?: string): Promise<boolean> {
  const cachePath = bareRepoPath(repoFullName);
  const repoUrl = githubToken
    ? `https://${githubToken}@github.com/${repoFullName}.git`
    : `https://github.com/${repoFullName}.git`;

  log.info('Updating bare repo cache', { repoFullName, cachePath });

  try {
    if (await pathExists(cachePath)) {
      // Fetch latest refs into existing cache
      log.info('Fetching updates for cached repo', { repoFullName });
      await run('git', ['-C', cachePath, 'fetch', '--all', '--prune']);
    } else {
      // Create new bare repo cache
      log.info('Creating new bare repo cache', { repoFullName });
      await mkdir(REPOS_DIR, { recursive: true });
      await run('git', ['clone', '--bare', repoUrl, cachePath]);

      // Remove the token from the remote URL
      await run('git', [
        '-C',
        cachePath,
        'remote',
        'set-url',
        'origin',
        `https://github.com/${repoFullName}.git`,
      ]);
    }

    log.info('Bare repo cache updated', { repoFullName });
    return true;
  } catch (error) {
    log.warn('Failed to update bare repo cache', { repoFullName }, toError(error));
    return false;
  }
}

export interface WorktreeConfig {
  sessionId: string;
  repoFullName: string;
  branch: string;
  githubToken?: string;
}

export interface WorktreeResult {
  /** Relative path to repo within workspace (e.g., "my-repo") */
  repoPath: string;
  /** Absolute path to the worktree working directory */
  workingDir: string;
}

/**
 * Set up a git worktree for a session.
 *
 * 1. Updates/creates the bare repo cache
 * 2. Creates a worktree from the cache at /worktrees/{sessionId}/{repoName}
 * 3. Configures the remote and creates a session branch
 */
export async function setupWorktree(config: WorktreeConfig): Promise<WorktreeResult> {
  const { sessionId, repoFullName, branch, githubToken } = config;
  const repoName = repoFullName.split('/')[1];
  const workspacePath = getSessionWorkspacePath(sessionId);
  const worktreePath = join(workspacePath, repoName);

  log.info('Setting up worktree', { sessionId, repoFullName, branch });

  // Update bare repo cache
  const cacheReady = await updateBareRepoCache(repoFullName, githubToken);

  if (!cacheReady) {
    // Fall back to a regular clone if caching failed
    log.info('Cache unavailable, falling back to regular clone', { sessionId });
    await mkdir(workspacePath, { recursive: true });

    const repoUrl = githubToken
      ? `https://${githubToken}@github.com/${repoFullName}.git`
      : `https://github.com/${repoFullName}.git`;

    await run('git', ['clone', '--branch', branch, '--single-branch', repoUrl, worktreePath]);
  } else {
    // Create worktree from the bare repo cache
    const cachePath = bareRepoPath(repoFullName);
    await mkdir(workspacePath, { recursive: true });

    // Add worktree from the bare repo, checking out the specified branch
    await run('git', ['-C', cachePath, 'worktree', 'add', worktreePath, branch]);
  }

  // Widen fetch refspec to track all remote branches
  await run('git', [
    '-C',
    worktreePath,
    'config',
    'remote.origin.fetch',
    '+refs/heads/*:refs/remotes/origin/*',
  ]);

  // Set remote URL without token
  await run('git', [
    '-C',
    worktreePath,
    'remote',
    'set-url',
    'origin',
    `https://github.com/${repoFullName}.git`,
  ]);

  // Configure git credential helper if we have a token
  if (githubToken) {
    // Use a credential helper that returns the token for github.com
    await run('git', [
      '-C',
      worktreePath,
      'config',
      'credential.https://github.com.helper',
      `!f() { echo "protocol=https"; echo "host=github.com"; echo "username=x-access-token"; echo "password=${githubToken}"; }; f`,
    ]);
  }

  // Create and check out a session-specific branch
  const sessionBranch = `${env.SESSION_BRANCH_PREFIX}${sessionId}`;
  await run('git', ['-C', worktreePath, 'checkout', '-b', sessionBranch]);

  log.info('Worktree set up successfully', { sessionId, repoName, branch: sessionBranch });

  return {
    repoPath: repoName,
    workingDir: worktreePath,
  };
}

/**
 * Create an empty workspace directory for a no-repo session.
 */
export async function createEmptyWorkspace(sessionId: string): Promise<string> {
  const workspacePath = getSessionWorkspacePath(sessionId);
  log.info('Creating empty workspace', { sessionId, workspacePath });
  await mkdir(workspacePath, { recursive: true });
  return workspacePath;
}

/**
 * Remove a session's worktree and workspace directory.
 */
export async function removeWorkspace(
  sessionId: string,
  repoFullName?: string | null
): Promise<void> {
  const workspacePath = getSessionWorkspacePath(sessionId);

  log.info('Removing workspace', { sessionId, workspacePath });

  try {
    // If this was a worktree, properly remove it from the bare repo first
    if (repoFullName) {
      const cachePath = bareRepoPath(repoFullName);
      const repoName = repoFullName.split('/')[1];
      const worktreePath = join(workspacePath, repoName);

      if (await pathExists(cachePath)) {
        try {
          await run('git', ['-C', cachePath, 'worktree', 'remove', '--force', worktreePath]);
        } catch (error) {
          log.warn('Failed to remove worktree from bare repo', { sessionId }, toError(error));
          // Continue to rm -rf the directory anyway
        }
      }
    }

    // Remove the workspace directory
    await rm(workspacePath, { recursive: true, force: true });
    log.info('Workspace removed', { sessionId });
  } catch (error) {
    log.error('Failed to remove workspace', toError(error), { sessionId });
    // Don't throw - cleanup failures shouldn't block session deletion
  }
}

/**
 * Get the current git branch in a worktree.
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
