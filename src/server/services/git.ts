import simpleGit from 'simple-git';
import { mkdir, rm, access } from 'fs/promises';
import { join } from 'path';
import { env } from '@/lib/env';

const WORKSPACES_DIR = join(env.DATA_DIR, 'workspaces');

export interface CloneResult {
  workspacePath: string;
}

function getWorkspacePath(sessionId: string): string {
  return join(WORKSPACES_DIR, sessionId);
}

async function ensureDir(dir: string): Promise<void> {
  try {
    await mkdir(dir, { recursive: true });
  } catch {
    // Directory might already exist
  }
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

export async function cloneRepo(
  repoFullName: string,
  branch: string,
  sessionId: string,
  githubToken?: string
): Promise<CloneResult> {
  await ensureDir(WORKSPACES_DIR);

  const workspacePath = getWorkspacePath(sessionId);

  // Build the clone URL with token if provided
  const repoUrl = githubToken
    ? `https://${githubToken}@github.com/${repoFullName}.git`
    : `https://github.com/${repoFullName}.git`;

  const git = simpleGit();
  await git.clone(repoUrl, workspacePath, ['--branch', branch, '--single-branch']);

  // Configure the remote URL without the token for security
  // The credential helper will provide the token when needed
  const workspaceGit = simpleGit(workspacePath);
  await workspaceGit.remote(['set-url', 'origin', `https://github.com/${repoFullName}.git`]);

  // Create and check out a session-specific branch to avoid working directly on main/master
  const sessionBranch = `${env.SESSION_BRANCH_PREFIX}${sessionId}`;
  await workspaceGit.checkoutLocalBranch(sessionBranch);

  return { workspacePath };
}

export async function removeWorkspace(sessionId: string): Promise<void> {
  const workspacePath = getWorkspacePath(sessionId);

  if (!(await pathExists(workspacePath))) {
    return;
  }

  await rm(workspacePath, { recursive: true, force: true });
}

export async function getDefaultBranch(
  repoFullName: string,
  githubToken?: string
): Promise<string> {
  // Use git ls-remote to get the default branch without cloning
  const git = simpleGit();
  const repoUrl = githubToken
    ? `https://${githubToken}@github.com/${repoFullName}.git`
    : `https://github.com/${repoFullName}.git`;

  try {
    const result = await git.listRemote(['--symref', repoUrl, 'HEAD']);
    // Parse output like: ref: refs/heads/main  HEAD
    const match = result.match(/ref: refs\/heads\/(\S+)/);
    if (match) {
      return match[1];
    }
  } catch {
    // Fallback
  }

  return 'main';
}

export async function listBranches(repoFullName: string, githubToken?: string): Promise<string[]> {
  const git = simpleGit();
  const repoUrl = githubToken
    ? `https://${githubToken}@github.com/${repoFullName}.git`
    : `https://github.com/${repoFullName}.git`;

  const result = await git.listRemote(['--heads', repoUrl]);

  // Parse output like: abc123  refs/heads/main
  const branches = result
    .split('\n')
    .filter((line) => line.includes('refs/heads/'))
    .map((line) => {
      const match = line.match(/refs\/heads\/(.+)$/);
      return match ? match[1] : null;
    })
    .filter((b): b is string => b !== null);

  return branches;
}

export function buildWorkspacePath(sessionId: string): string {
  return getWorkspacePath(sessionId);
}
