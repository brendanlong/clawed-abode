import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm, readdir, stat, mkdir, writeFile } from 'fs/promises';
import { join } from 'path';
import { tmpdir } from 'os';
import simpleGit from 'simple-git';

/**
 * Helper to create and initialize a git repo in a directory
 */
async function initRepo(dir: string, options: { bare?: boolean } = {}) {
  await mkdir(dir, { recursive: true });
  const git = simpleGit(dir);
  if (options.bare) {
    await git.init(['--bare']);
  } else {
    await git.init();
    await git.addConfig('user.email', 'test@test.com');
    await git.addConfig('user.name', 'Test');
  }
  return git;
}

/**
 * Integration tests for git operations.
 * These tests use real git commands in temporary directories.
 *
 * Note: We test the git parsing logic here rather than the actual service functions
 * because the service functions have dependencies on environment variables and
 * file permissions that are difficult to mock in a clean way.
 */

describe('git integration', () => {
  let tempDir: string;
  let repoDir: string;

  beforeEach(async () => {
    // Create a temp directory for our test repos
    tempDir = await mkdtemp(join(tmpdir(), 'git-test-'));
    repoDir = join(tempDir, 'repo');
  });

  afterEach(async () => {
    // Clean up
    await rm(tempDir, { recursive: true, force: true });
  });

  describe('branch parsing', () => {
    it('should list branches from ls-remote output', async () => {
      // Create a bare repo to simulate a remote
      const bareDir = join(tempDir, 'bare.git');
      await initRepo(bareDir, { bare: true });

      // Clone it and create branches
      const git = simpleGit();
      await git.clone(bareDir, repoDir);
      const workGit = simpleGit(repoDir);
      await workGit.addConfig('user.email', 'test@test.com');
      await workGit.addConfig('user.name', 'Test');

      // Create initial commit (required before creating branches)
      await writeFile(join(repoDir, 'test.txt'), 'test');
      await workGit.add('test.txt');
      await workGit.commit('Initial commit');
      await workGit.push('origin', 'master');

      // Create additional branches
      await workGit.checkoutLocalBranch('feature-1');
      await workGit.push('origin', 'feature-1');
      await workGit.checkoutLocalBranch('feature-2');
      await workGit.push('origin', 'feature-2');

      // Now test ls-remote parsing (simulating what listBranches does)
      const result = await git.listRemote(['--heads', bareDir]);

      const branches = result
        .split('\n')
        .filter((line) => line.includes('refs/heads/'))
        .map((line) => {
          const match = line.match(/refs\/heads\/(.+)$/);
          return match ? match[1] : null;
        })
        .filter((b): b is string => b !== null);

      expect(branches).toContain('master');
      expect(branches).toContain('feature-1');
      expect(branches).toContain('feature-2');
    });

    it('should detect default branch from ls-remote --symref', async () => {
      // Create a bare repo
      const bareDir = join(tempDir, 'bare.git');
      await initRepo(bareDir, { bare: true });

      // Clone and set up main branch
      const git = simpleGit();
      await git.clone(bareDir, repoDir);
      const workGit = simpleGit(repoDir);
      await workGit.addConfig('user.email', 'test@test.com');
      await workGit.addConfig('user.name', 'Test');

      // Create initial commit
      await writeFile(join(repoDir, 'test.txt'), 'test');
      await workGit.add('test.txt');
      await workGit.commit('Initial commit');

      // Rename master to main and push
      await workGit.branch(['-m', 'master', 'main']);
      await workGit.push('origin', 'main');

      // Update HEAD in bare repo to point to main
      const bareGit = simpleGit(bareDir);
      await bareGit.raw(['symbolic-ref', 'HEAD', 'refs/heads/main']);

      // Test ls-remote --symref parsing (simulating getDefaultBranch)
      const result = await git.listRemote(['--symref', bareDir, 'HEAD']);
      const match = result.match(/ref: refs\/heads\/(\S+)/);

      expect(match).not.toBeNull();
      expect(match![1]).toBe('main');
    });
  });

  describe('clone operations', () => {
    it('should clone a repository with a specific branch', async () => {
      // Create a source repo
      const sourceDir = join(tempDir, 'source');
      const sourceGit = await initRepo(sourceDir);

      // Create initial commit
      await writeFile(join(sourceDir, 'test.txt'), 'content');
      await sourceGit.add('test.txt');
      await sourceGit.commit('Initial');

      // Create a develop branch
      await sourceGit.checkoutLocalBranch('develop');
      await writeFile(join(sourceDir, 'dev.txt'), 'dev content');
      await sourceGit.add('dev.txt');
      await sourceGit.commit('Dev commit');

      // Clone only the develop branch
      const cloneDir = join(tempDir, 'clone');
      const git = simpleGit();
      await git.clone(sourceDir, cloneDir, ['--branch', 'develop', '--single-branch']);

      // Verify we're on develop branch
      const cloneGit = simpleGit(cloneDir);
      const branch = await cloneGit.branch();
      expect(branch.current).toBe('develop');

      // Verify the develop-specific file exists
      const files = await readdir(cloneDir);
      expect(files).toContain('dev.txt');
    });

    it('should create a new local branch from cloned repo', async () => {
      // Create source repo
      const sourceDir = join(tempDir, 'source');
      const sourceGit = await initRepo(sourceDir);

      // Initial commit
      await writeFile(join(sourceDir, 'test.txt'), 'test');
      await sourceGit.add('test.txt');
      await sourceGit.commit('Initial');

      // Clone
      const cloneDir = join(tempDir, 'clone');
      const git = simpleGit();
      await git.clone(sourceDir, cloneDir);

      // Create new branch (simulating session branch creation)
      const cloneGit = simpleGit(cloneDir);
      const sessionBranch = 'claude/session-123';
      await cloneGit.checkoutLocalBranch(sessionBranch);

      const branch = await cloneGit.branch();
      expect(branch.current).toBe(sessionBranch);
    });
  });

  describe('remote URL handling', () => {
    it('should update remote URL', async () => {
      // Create and clone a repo
      const sourceDir = join(tempDir, 'source');
      const sourceGit = await initRepo(sourceDir);
      await writeFile(join(sourceDir, 'test.txt'), 'test');
      await sourceGit.add('test.txt');
      await sourceGit.commit('Initial');

      const cloneDir = join(tempDir, 'clone');
      const git = simpleGit();
      await git.clone(sourceDir, cloneDir);

      // Update remote URL (simulating removing token from URL)
      const cloneGit = simpleGit(cloneDir);
      await cloneGit.remote(['set-url', 'origin', 'https://github.com/user/repo.git']);

      // Verify the remote was updated
      const remotes = await cloneGit.getRemotes(true);
      const origin = remotes.find((r) => r.name === 'origin');
      expect(origin?.refs.fetch).toBe('https://github.com/user/repo.git');
    });
  });

  describe('workspace management', () => {
    it('should detect if a directory exists', async () => {
      const existingDir = join(tempDir, 'existing');
      await mkdir(existingDir);

      const existingStats = await stat(existingDir).catch(() => null);
      expect(existingStats?.isDirectory()).toBe(true);

      const nonExistingStats = await stat(join(tempDir, 'nonexisting')).catch(() => null);
      expect(nonExistingStats).toBeNull();
    });

    it('should recursively delete a workspace directory', async () => {
      // Create a directory with nested content
      const workspaceDir = join(tempDir, 'workspace');
      const nestedDir = join(workspaceDir, 'nested', 'deep');
      await mkdir(nestedDir, { recursive: true });
      await writeFile(join(nestedDir, 'file.txt'), 'content');

      // Delete it
      await rm(workspaceDir, { recursive: true, force: true });

      // Verify it's gone
      const stats = await stat(workspaceDir).catch(() => null);
      expect(stats).toBeNull();
    });
  });
});
