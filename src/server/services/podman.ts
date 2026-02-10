import { spawn } from 'child_process';
import { existsSync, mkdirSync } from 'fs';
import { chmod } from 'fs/promises';
import { resolve } from 'path';
import { env } from '@/lib/env';
import { createLogger, toError } from '@/lib/logger';
import { v4 as uuid } from 'uuid';

const log = createLogger('podman');

// Use env variable if set, otherwise default to local build
const CLAUDE_CODE_IMAGE = env.CLAUDE_RUNNER_IMAGE;

// Track last pull time per image to avoid pulling too frequently
const lastPullTime = new Map<string, number>();
const PULL_INTERVAL_MS = 5 * 60 * 1000; // 5 minutes (matches Watchtower poll interval)

/**
 * Check if we're running inside a container.
 * Podman creates /run/.containerenv, Docker creates /.dockerenv.
 */
function isRunningInContainer(): boolean {
  return existsSync('/run/.containerenv') || existsSync('/.dockerenv');
}

/**
 * Environment for podman commands.
 * In container-in-container setups, sets CONTAINER_HOST to use the Docker socket
 * mounted from the host. This is necessary because the inner Podman has limited
 * UID/GID mappings. In local dev, we don't set CONTAINER_HOST so podman uses
 * its default socket.
 */
const DOCKER_SOCKET_PATH = '/var/run/docker.sock';
const podmanEnv: NodeJS.ProcessEnv = isRunningInContainer()
  ? { ...process.env, CONTAINER_HOST: `unix://${DOCKER_SOCKET_PATH}` }
  : { ...process.env };

/**
 * Run a podman command and return a promise that resolves with stdout.
 * @param args - Arguments to pass to podman
 * @param useSudo - Run with sudo (needed when reading files with restricted permissions in containerized deployments)
 */
async function runPodman(args: string[], useSudo = false): Promise<string> {
  return new Promise((resolve, reject) => {
    let command: string;
    let finalArgs: string[];

    if (useSudo) {
      // When using sudo, we need to preserve CONTAINER_HOST so sudo's podman
      // talks to the same Podman instance (via the socket) as the non-sudo commands.
      // Without this, sudo podman would use root's separate Podman instance.
      // The sudoers config allows CONTAINER_HOST via env_keep.
      command = 'sudo';
      finalArgs = ['--preserve-env=CONTAINER_HOST', 'podman', ...args];
    } else {
      command = 'podman';
      finalArgs = args;
    }

    log.debug('runPodman: Executing', { args: finalArgs, useSudo });
    const proc = spawn(command, finalArgs, { env: podmanEnv });
    let stdout = '';
    let stderr = '';

    proc.stdout.on('data', (data: Buffer) => {
      stdout += data.toString();
    });

    proc.stderr.on('data', (data: Buffer) => {
      stderr += data.toString();
    });

    proc.on('close', (code) => {
      if (code === 0) {
        resolve(stdout);
      } else {
        log.debug('runPodman: Command failed', { args: finalArgs, code, stderr });
        reject(new Error(`podman command failed with code ${code}: ${stderr}`));
      }
    });

    proc.on('error', (err) => {
      reject(err);
    });
  });
}

/**
 * Run a podman command, ignoring non-zero exit codes.
 */
async function runPodmanIgnoreErrors(args: string[]): Promise<string> {
  return new Promise((resolve) => {
    log.debug('runPodmanIgnoreErrors: Executing', { args });
    const proc = spawn('podman', args, { env: podmanEnv });
    let stdout = '';

    proc.stdout.on('data', (data: Buffer) => {
      stdout += data.toString();
    });

    proc.on('close', () => {
      resolve(stdout);
    });

    proc.on('error', () => {
      resolve('');
    });
  });
}

/**
 * Run a podman command in the background without waiting for it to complete.
 * Fire-and-forget - no result is returned.
 * Useful for cleanup operations that don't need to block.
 */
function runPodmanBackground(args: string[]): void {
  log.debug('runPodmanBackground: Starting', { args });
  const proc = spawn('podman', args, {
    env: podmanEnv,
    stdio: 'ignore',
    detached: true,
  });
  // unref() allows the parent process to exit without waiting for this child
  proc.unref();
}

/**
 * Clean up a temporary container in the background.
 * Uses SIGKILL for instant termination since we don't need graceful shutdown.
 * This avoids the 10-second default stop timeout.
 */
function cleanupContainerBackground(containerId: string): void {
  log.debug('cleanupContainerBackground: Cleaning up', { containerId });
  // Use rm -f which sends SIGKILL and removes in one step
  // Much faster than stop (which waits for graceful shutdown) + rm
  runPodmanBackground(['rm', '-f', containerId]);
}

/**
 * Ensure an image is up-to-date by pulling it.
 * Pulls are rate-limited to once per 5 minutes per image to avoid excessive pulls.
 * Set SKIP_IMAGE_PULL=true to skip pulling entirely (useful for testing local builds).
 */
async function ensureImagePulled(imageName: string): Promise<void> {
  // Skip pulling if explicitly disabled (useful for testing local image builds)
  if (env.SKIP_IMAGE_PULL) {
    log.debug('Skipping pull, SKIP_IMAGE_PULL is set', { imageName });
    return;
  }

  const lastPull = lastPullTime.get(imageName);
  const now = Date.now();

  // Skip if we've pulled recently
  if (lastPull && now - lastPull < PULL_INTERVAL_MS) {
    log.debug('Skipping pull, recently pulled', { imageName, msAgo: now - lastPull });
    return;
  }

  log.info('Pulling image', { imageName });

  try {
    await runPodman(['pull', imageName]);
    log.info('Image pull complete', { imageName });
    lastPullTime.set(imageName, Date.now());
  } catch (error) {
    log.error('Failed to pull image', toError(error), { imageName });
    throw error;
  }
}

/**
 * Check if a volume string is a host path (starts with . or /) or a named volume.
 */
function isHostPath(volumeSpec: string): boolean {
  return volumeSpec.startsWith('.') || volumeSpec.startsWith('/');
}

/**
 * Get the absolute path for a sockets location, whether it's a host path or volume name.
 * For host paths, resolves to absolute path.
 * For volume names, returns the volume name as-is.
 */
function getSocketsPath(socketsSpec: string): string {
  if (isHostPath(socketsSpec)) {
    return resolve(socketsSpec);
  }
  return socketsSpec;
}

/**
 * Ensure the sockets location exists, creating it if necessary.
 * For host paths, creates the directory.
 * For named volumes, creates the volume.
 */
async function ensureSocketsVolume(): Promise<void> {
  const socketsSpec = env.SOCKETS_VOLUME;

  if (isHostPath(socketsSpec)) {
    // Host path - ensure directory exists with proper permissions
    const socketsPath = getSocketsPath(socketsSpec);
    if (!existsSync(socketsPath)) {
      log.info('Creating sockets directory', { socketsPath });
      mkdirSync(socketsPath, { recursive: true, mode: 0o777 });
    }
    // Ensure directory has write permissions for all users
    // This is needed so container users can create socket files
    await chmod(socketsPath, 0o777);
  } else {
    // Named volume - ensure it exists
    try {
      await runPodman(['volume', 'inspect', socketsSpec]);
    } catch {
      // Volume doesn't exist, create it
      log.info('Creating sockets volume', { volumeName: socketsSpec });
      await runPodman(['volume', 'create', socketsSpec]);
    }
  }
}

/**
 * Clean up a session's socket file.
 * For host paths, deletes directly. For volumes, uses a temporary container.
 */
export async function cleanupSessionSocket(sessionId: string): Promise<void> {
  const socketsSpec = env.SOCKETS_VOLUME;
  const socketPath = `/sockets/${sessionId}.sock`;

  log.info('Cleaning up session socket', { sessionId });

  try {
    if (isHostPath(socketsSpec)) {
      // Host path - delete directly
      const fs = await import('fs/promises');
      const absolutePath = resolve(getSocketsPath(socketsSpec), `${sessionId}.sock`);
      try {
        await fs.unlink(absolutePath);
        log.info('Socket file cleaned up', { sessionId, path: absolutePath });
      } catch (err) {
        // File might not exist, which is fine
        if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
          throw err;
        }
      }
    } else {
      // Named volume - use temporary container
      const containerName = `cleanup-socket-${uuid().slice(0, 8)}`;
      await ensureSocketsVolume();

      const containerId = (
        await runPodman([
          'create',
          '--name',
          containerName,
          '--rm',
          '--entrypoint',
          '/bin/rm',
          '-v',
          `${socketsSpec}:/sockets`,
          CLAUDE_CODE_IMAGE,
          '-f',
          socketPath,
        ])
      ).trim();

      await runPodman(['start', containerId]);
      // Container auto-removes after command completes
      log.info('Socket file cleaned up', { sessionId, socketPath });
    }
  } catch (error) {
    log.warn('Failed to clean up socket file', { sessionId }, toError(error));
    // Don't throw - cleanup failures shouldn't block session operations
  }
}

/**
 * Convert a repo full name (e.g., "owner/repo") to a cache-safe path.
 * Uses double-dash to separate owner and repo since slashes aren't valid in paths.
 */
function repoCachePath(repoFullName: string): string {
  return `/cache/${repoFullName.replace('/', '--')}.git`;
}

/**
 * Ensure the git cache volume exists, creating it if necessary.
 */
async function ensureGitCacheVolume(): Promise<void> {
  const volumeName = env.GIT_CACHE_VOLUME;
  try {
    // Check if volume exists
    await runPodman(['volume', 'inspect', volumeName]);
  } catch {
    // Volume doesn't exist, create it
    log.info('Creating git cache volume', { volumeName });
    await runPodman(['volume', 'create', volumeName]);
  }
}

/**
 * Update or create a bare repo cache for a given repository.
 * If the cache exists, fetches latest refs. If not, clones a new bare repo.
 * This is done in a temporary container to ensure proper permissions.
 *
 * @returns true if cache is ready to use as --reference, false if caching failed
 */
async function updateGitCache(repoFullName: string, githubToken?: string): Promise<boolean> {
  const containerName = `git-cache-${uuid().slice(0, 8)}`;
  const cachePath = repoCachePath(repoFullName);

  // Build the repo URL with token if provided
  const repoUrl = githubToken
    ? `https://${githubToken}@github.com/${repoFullName}.git`
    : `https://github.com/${repoFullName}.git`;

  log.info('Updating git cache', { repoFullName, cachePath });

  try {
    await ensureGitCacheVolume();

    // Create a temporary container with the cache volume mounted
    // Override entrypoint to avoid starting agent service (which would fail without sockets volume)
    const createArgs = [
      'create',
      '--name',
      containerName,
      '--rm',
      '--entrypoint',
      '/bin/sleep',
      '-v',
      `${env.GIT_CACHE_VOLUME}:/cache`,
      '-w',
      '/cache',
      CLAUDE_CODE_IMAGE,
      'infinity',
    ];

    const containerId = (await runPodman(createArgs)).trim();
    await runPodman(['start', containerId]);

    try {
      // Check if the cache repo already exists
      const lsResult = await runPodmanIgnoreErrors(['exec', containerId, 'ls', '-d', cachePath]);
      const cacheExists = lsResult.trim() === cachePath;

      if (cacheExists) {
        // Cache exists - fetch latest refs
        log.info('Fetching updates for cached repo', { repoFullName });
        await runPodman(['exec', containerId, 'git', '-C', cachePath, 'fetch', '--all', '--prune']);
      } else {
        // Cache doesn't exist - clone a bare repo
        log.info('Creating new bare repo cache', { repoFullName });

        // Ensure the parent directory exists
        const parentDir = cachePath.substring(0, cachePath.lastIndexOf('/'));
        await runPodman(['exec', containerId, 'mkdir', '-p', parentDir]);

        await runPodman(['exec', containerId, 'git', 'clone', '--bare', repoUrl, cachePath]);

        // Remove the token from the remote URL for security
        await runPodman([
          'exec',
          containerId,
          'git',
          '-C',
          cachePath,
          'remote',
          'set-url',
          'origin',
          `https://github.com/${repoFullName}.git`,
        ]);
      }

      log.info('Git cache updated successfully', { repoFullName });
      return true;
    } finally {
      // Clean up the temporary container in the background
      // This avoids the ~10 second stop timeout since we use rm -f (SIGKILL)
      cleanupContainerBackground(containerId);
    }
  } catch (error) {
    log.warn(
      'Failed to update git cache, will clone without reference',
      { repoFullName },
      toError(error)
    );
    return false;
  }
}

export interface CloneConfig {
  sessionId: string;
  repoFullName: string;
  branch: string;
  githubToken?: string;
}

export interface CloneResult {
  repoPath: string; // Relative path to repo within workspace (e.g., "my-repo")
}

/**
 * Clone a repository into the workspaces volume using a temporary container.
 * This ensures the clone goes directly into the named volume, avoiding
 * permission issues between the service and runner containers.
 *
 * Uses a git reference cache when available to speed up clones.
 * The cache stores bare repos that are fetched on each clone to stay current.
 * If caching fails, falls back to a normal clone.
 */
export async function cloneRepoInVolume(config: CloneConfig): Promise<CloneResult> {
  const containerName = `clone-${config.sessionId}`;
  log.info('Cloning repo in volume', {
    sessionId: config.sessionId,
    repoFullName: config.repoFullName,
    branch: config.branch,
  });

  const volumeName = `clawed-abode-workspace-${config.sessionId}`;

  try {
    // Ensure the image is pulled before creating the container
    await ensureImagePulled(CLAUDE_CODE_IMAGE);

    // Update or create the git cache for this repo
    // This fetches latest refs so the clone will be fast and current
    const useCache = await updateGitCache(config.repoFullName, config.githubToken);
    const cachePath = repoCachePath(config.repoFullName);

    // Create a dedicated volume for this session
    await runPodman(['volume', 'create', volumeName]);
    log.info('Created session volume', { sessionId: config.sessionId, volumeName });

    // Build the clone URL with token if provided
    const repoUrl = config.githubToken
      ? `https://${config.githubToken}@github.com/${config.repoFullName}.git`
      : `https://github.com/${config.repoFullName}.git`;

    // Extract repo name from full name (e.g., "owner/repo" -> "repo")
    const repoName = config.repoFullName.split('/')[1];

    // Create a temporary container with the session's volume mounted
    // Also mount the git cache volume if we're using it
    // Override entrypoint to avoid starting agent service (which would fail without sockets volume)
    const createArgs = [
      'create',
      '--name',
      containerName,
      '--rm', // Auto-remove when stopped
      '--entrypoint',
      '/bin/sleep',
      '-v',
      `${volumeName}:/workspace`,
      ...(useCache ? ['-v', `${env.GIT_CACHE_VOLUME}:/cache:ro`] : []),
      '-w',
      '/workspace',
      CLAUDE_CODE_IMAGE,
      'infinity',
    ];

    const containerId = (await runPodman(createArgs)).trim();
    log.info('Clone container created', { sessionId: config.sessionId, containerId, useCache });

    // Start the container
    await runPodman(['start', containerId]);

    try {
      // Clone the repository, using --reference if cache is available
      // --dissociate ensures the clone is independent even if the cache is deleted later
      const cloneArgs = [
        'exec',
        containerId,
        'git',
        'clone',
        '--branch',
        config.branch,
        '--single-branch',
        ...(useCache ? ['--reference', cachePath, '--dissociate'] : []),
        repoUrl,
        repoName,
      ];
      await runPodman(cloneArgs);

      // Configure the remote URL without the token for security
      await runPodman([
        'exec',
        containerId,
        'git',
        '-C',
        repoName,
        'remote',
        'set-url',
        'origin',
        `https://github.com/${config.repoFullName}.git`,
      ]);

      // Create and check out a session-specific branch
      const sessionBranch = `${env.SESSION_BRANCH_PREFIX}${config.sessionId}`;
      await runPodman([
        'exec',
        containerId,
        'git',
        '-C',
        repoName,
        'checkout',
        '-b',
        sessionBranch,
      ]);

      log.info('Repo cloned successfully', {
        sessionId: config.sessionId,
        repoName,
        branch: sessionBranch,
      });

      return { repoPath: repoName };
    } finally {
      // Clean up the temporary container in the background
      // This avoids the ~10 second stop timeout since we use rm -f (SIGKILL)
      cleanupContainerBackground(containerId);
    }
  } catch (error) {
    log.error('Failed to clone repo in volume', toError(error), {
      sessionId: config.sessionId,
      repoFullName: config.repoFullName,
    });
    // Clean up the volume if clone failed
    await runPodmanIgnoreErrors(['volume', 'rm', volumeName]);
    throw error;
  }
}

/**
 * Remove a session's workspace volume.
 */
export async function removeWorkspaceFromVolume(sessionId: string): Promise<void> {
  const volumeName = `clawed-abode-workspace-${sessionId}`;
  log.info('Removing workspace volume', { sessionId, volumeName });

  try {
    await runPodman(['volume', 'rm', volumeName]);
    log.info('Workspace volume removed', { sessionId, volumeName });
  } catch (error) {
    log.error('Failed to remove workspace volume', toError(error), { sessionId, volumeName });
    // Don't throw - cleanup failures shouldn't block session deletion
  }
}

export interface ContainerConfig {
  sessionId: string;
  repoPath: string; // Relative path to repo within workspace (e.g., "my-repo")
  githubToken?: string;
  // System prompt to pass to the agent service
  systemPrompt?: string;
  // Per-repo environment variables
  repoEnvVars?: Array<{ name: string; value: string }>;
  // Claude model override (from global settings DB). Falls back to CLAUDE_MODEL env var.
  claudeModel?: string;
  // Claude API key override (from global settings DB). Falls back to CLAUDE_CODE_OAUTH_TOKEN env var.
  claudeApiKey?: string;
}

export async function createAndStartContainer(config: ContainerConfig): Promise<string> {
  const containerName = `claude-session-${config.sessionId}`;
  log.info('Creating container', { sessionId: config.sessionId, containerName });

  try {
    // Check if container already exists
    const existingOutput = await runPodmanIgnoreErrors([
      'ps',
      '-a',
      '--filter',
      `name=^${containerName}$`,
      '--format',
      '{{.ID}}\t{{.State}}',
    ]);

    const lines = existingOutput.trim().split('\n').filter(Boolean);
    if (lines.length > 0) {
      const [containerId, state] = lines[0].split('\t');
      log.info('Found existing container', {
        sessionId: config.sessionId,
        containerId,
        state,
      });

      if (state !== 'running') {
        await runPodman(['start', containerId]);
        log.info('Started existing container', {
          sessionId: config.sessionId,
          containerId,
        });
      }
      return containerId;
    }

    // Build environment variables
    const envArgs: string[] = [];
    if (config.githubToken) {
      envArgs.push('-e', `GITHUB_TOKEN=${config.githubToken}`);
    }
    // Claude Code OAuth token for authentication (DB override takes precedence over env var)
    const oauthToken = config.claudeApiKey || env.CLAUDE_CODE_OAUTH_TOKEN;
    if (!oauthToken) {
      throw new Error(
        'No Claude API key configured. Set CLAUDE_CODE_OAUTH_TOKEN environment variable or configure it in Settings.'
      );
    }
    envArgs.push('-e', `CLAUDE_CODE_OAUTH_TOKEN=${oauthToken}`);
    // Set Gradle user home to use the shared cache volume
    envArgs.push('-e', 'GRADLE_USER_HOME=/gradle-cache');
    // Add NVIDIA environment variables for GPU access
    envArgs.push('-e', 'NVIDIA_VISIBLE_DEVICES=all');
    envArgs.push('-e', 'NVIDIA_DRIVER_CAPABILITIES=all');
    // Set CONTAINER_HOST so podman/docker commands inside the container use the host's socket
    if (env.PODMAN_SOCKET_PATH) {
      envArgs.push('-e', 'CONTAINER_HOST=unix:///var/run/docker.sock');
    }
    // Agent service configuration - use Unix socket instead of TCP port
    envArgs.push('-e', `AGENT_SOCKET_PATH=/sockets/${config.sessionId}.sock`);
    if (config.systemPrompt) {
      envArgs.push('-e', `SYSTEM_PROMPT=${config.systemPrompt}`);
    }
    // Claude model (DB override takes precedence over env var)
    envArgs.push('-e', `CLAUDE_MODEL=${config.claudeModel ?? env.CLAUDE_MODEL}`);

    // Add per-repo environment variables
    if (config.repoEnvVars) {
      for (const envVar of config.repoEnvVars) {
        envArgs.push('-e', `${envVar.name}=${envVar.value}`);
      }
    }

    // Build volume binds
    // Each session has its own dedicated volume for isolation
    const volumeName = `clawed-abode-workspace-${config.sessionId}`;
    const volumeArgs: string[] = ['-v', `${volumeName}:/workspace`];

    // Mount shared pnpm store volume
    volumeArgs.push('-v', `${env.PNPM_STORE_VOLUME}:/pnpm-store`);
    // Mount shared Gradle cache subdirectories (caches/ and wrapper/ only)
    // The daemon/ directory is intentionally NOT shared to avoid stale Gradle daemons
    // from previous container sessions (see issue #238)
    volumeArgs.push('-v', `${env.GRADLE_CACHES_VOLUME}:/gradle-cache/caches`);
    volumeArgs.push('-v', `${env.GRADLE_WRAPPER_VOLUME}:/gradle-cache/wrapper`);
    // Mount sockets location for agent service communication
    // Use absolute path for host directories, volume name for named volumes
    const socketsMount = `${getSocketsPath(env.SOCKETS_VOLUME)}:/sockets`;
    volumeArgs.push('-v', socketsMount);

    // Mount host's podman socket for container-in-container support (read-only)
    if (env.PODMAN_SOCKET_PATH) {
      volumeArgs.push('-v', `${env.PODMAN_SOCKET_PATH}:/var/run/docker.sock`);
    }

    // Working directory is the repo path inside the session's workspace
    // The session's workspace is mounted at /workspace, so the repo is at /workspace/{repoPath}
    const workingDir = config.repoPath ? `/workspace/${config.repoPath}` : '/workspace';

    log.info('Creating new container', {
      sessionId: config.sessionId,
      image: CLAUDE_CODE_IMAGE,
      workingDir,
    });

    // Ensure the image is pulled before creating the container
    await ensureImagePulled(CLAUDE_CODE_IMAGE);

    // Ensure the sockets volume exists
    await ensureSocketsVolume();

    // GPU access via CDI (Container Device Interface) - requires nvidia-container-toolkit
    // and CDI specs generated via: nvidia-ctk cdi generate --output=/etc/cdi/nvidia.yaml
    //
    // Network mode is configurable via CONTAINER_NETWORK_MODE:
    // - "host": Share host's network namespace. Allows containers to connect to
    //   services started via podman-compose on localhost. Recommended when agents
    //   need to run and connect to containerized services.
    // - "bridge": Standard container networking with NAT.
    // - "pasta": Rootless Podman's default.
    // See: https://github.com/brendanlong/clawed-abode/issues/147
    const createArgs = [
      'create',
      '--name',
      containerName,
      '--network',
      env.CONTAINER_NETWORK_MODE,
      '--security-opt',
      'label=disable',
      '--device',
      'nvidia.com/gpu=all',
      '-w',
      workingDir,
      ...envArgs,
      ...volumeArgs,
      CLAUDE_CODE_IMAGE,
      // Container runs the agent service via its CMD (node /opt/agent-service/dist/index.js)
    ];

    const containerId = (await runPodman(createArgs)).trim();
    log.info('Container created', { sessionId: config.sessionId, containerId });

    // Start the container
    // The entrypoint script handles runtime setup (git credentials, sudo fix,
    // pnpm store, podman socket permissions, MCP config) then starts the agent service.
    await runPodman(['start', containerId]);
    log.info('Container started', { sessionId: config.sessionId, containerId });

    return containerId;
  } catch (error) {
    log.error('Failed to create/start container', toError(error), {
      sessionId: config.sessionId,
      containerName,
      image: CLAUDE_CODE_IMAGE,
    });
    throw error;
  }
}

/**
 * Verify a container is fully initialized and healthy.
 * Runs a simple command to ensure the container can execute processes.
 * Returns true if healthy, throws an error if not.
 */
export async function verifyContainerHealth(containerId: string): Promise<void> {
  log.debug('Verifying container health', { containerId });

  // First check container status
  const state = await getContainerState(containerId);
  if (state.status !== 'running') {
    const logs = await getContainerLogs(containerId, { tail: 30 });
    throw new Error(
      `Container is not running (status: ${state.status}, exit code: ${state.exitCode}, error: ${state.error})${logs ? `\nLogs:\n${logs}` : ''}`
    );
  }

  // Try to run a simple command to verify the container is responsive
  try {
    await runPodman(['exec', containerId, 'echo', 'health-check']);
  } catch (error) {
    const logs = await getContainerLogs(containerId, { tail: 30 });
    throw new Error(
      `Container health check failed: ${toError(error).message}${logs ? `\nLogs:\n${logs}` : ''}`
    );
  }

  log.debug('Container health verified', { containerId });
}

export async function stopContainer(containerId: string): Promise<void> {
  try {
    await runPodman(['stop', '-t', '10', containerId]);
  } catch (error) {
    // Container might already be stopped
    if (!(error instanceof Error && error.message.includes('not running'))) {
      throw error;
    }
  }
}

export async function removeContainer(containerId: string): Promise<void> {
  try {
    await runPodmanIgnoreErrors(['stop', '-t', '5', containerId]);
  } catch {
    // Ignore stop errors
  }
  try {
    await runPodmanIgnoreErrors(['rm', '-f', containerId]);
  } catch {
    // Ignore remove errors if already removed
  }
}

export async function getContainerStatus(
  containerId: string
): Promise<'running' | 'stopped' | 'not_found'> {
  try {
    const output = await runPodman(['inspect', '--format', '{{.State.Running}}', containerId]);
    const isRunning = output.trim() === 'true';
    return isRunning ? 'running' : 'stopped';
  } catch {
    return 'not_found';
  }
}

/**
 * Detailed container state information for diagnostics.
 */
export interface ContainerState {
  status: 'running' | 'stopped' | 'not_found';
  exitCode: number | null;
  error: string | null;
  startedAt: string | null;
  finishedAt: string | null;
  oomKilled: boolean;
}

/**
 * Get detailed container state information.
 * Returns more diagnostic info than getContainerStatus for error investigation.
 */
export async function getContainerState(containerId: string): Promise<ContainerState> {
  try {
    // Use JSON format for reliable parsing of multiple fields
    const output = await runPodman(['inspect', '--format', '{{json .State}}', containerId]);
    const state = JSON.parse(output.trim());
    return {
      status: state.Running ? 'running' : 'stopped',
      exitCode: state.ExitCode ?? null,
      error: state.Error || null,
      startedAt: state.StartedAt || null,
      finishedAt: state.FinishedAt || null,
      oomKilled: state.OOMKilled ?? false,
    };
  } catch {
    return {
      status: 'not_found',
      exitCode: null,
      error: null,
      startedAt: null,
      finishedAt: null,
      oomKilled: false,
    };
  }
}

/**
 * Get recent logs from a container.
 * Useful for diagnosing container failures or process crashes.
 *
 * @param containerId - The container ID
 * @param options - Options for log retrieval
 * @returns Container logs or null if unavailable
 */
export async function getContainerLogs(
  containerId: string,
  options: {
    tail?: number; // Number of lines from the end (default: 100)
    since?: string; // Show logs since timestamp (e.g., "10m" for 10 minutes ago)
  } = {}
): Promise<string | null> {
  const { tail = 100, since } = options;

  try {
    const args = ['logs', '--tail', tail.toString()];
    if (since) {
      args.push('--since', since);
    }
    args.push(containerId);

    const output = await runPodman(args);
    return output || null;
  } catch (error) {
    log.debug('Failed to get container logs', { containerId, error: toError(error).message });
    return null;
  }
}

/**
 * Container info returned from listSessionContainers.
 */
export interface SessionContainerInfo {
  containerId: string;
  sessionId: string;
  status: 'running' | 'stopped';
}

/**
 * List all claude-session-* containers and their status.
 * Returns container ID, session ID (extracted from name), and running status.
 */
export async function listSessionContainers(): Promise<SessionContainerInfo[]> {
  try {
    // Use filter to only get containers with our naming pattern
    // Format: ID<tab>Name<tab>State
    const output = await runPodman([
      'ps',
      '-a',
      '--filter',
      'name=^claude-session-',
      '--format',
      '{{.ID}}\t{{.Names}}\t{{.State}}',
    ]);

    const containers: SessionContainerInfo[] = [];
    const lines = output.trim().split('\n').filter(Boolean);

    for (const line of lines) {
      const [containerId, name, state] = line.split('\t');
      // Extract session ID from container name (format: claude-session-{sessionId})
      const sessionIdMatch = name?.match(/^claude-session-(.+)$/);
      if (sessionIdMatch && containerId) {
        // State can be either "running" (direct podman) or "Up X minutes" (via Docker socket)
        const isRunning = state === 'running' || state?.toLowerCase().startsWith('up ');
        containers.push({
          containerId: containerId.trim(),
          sessionId: sessionIdMatch[1],
          status: isRunning ? 'running' : 'stopped',
        });
      }
    }

    return containers;
  } catch (error) {
    log.error('Failed to list session containers', toError(error));
    return [];
  }
}

/**
 * Check if an exit code indicates an error.
 */
export function isErrorExitCode(exitCode: number | null): boolean {
  return exitCode !== null && exitCode !== 0;
}

/**
 * Get a human-readable description of an exit code.
 */
export function describeExitCode(exitCode: number | null): string {
  if (exitCode === null) {
    return 'unknown exit code';
  }
  if (exitCode === 0) {
    return 'success';
  }
  // Common signal exit codes (128 + signal number)
  if (exitCode === 137) {
    return 'killed (SIGKILL) - possibly out of memory';
  }
  if (exitCode === 139) {
    return 'segmentation fault (SIGSEGV)';
  }
  if (exitCode === 143) {
    return 'terminated (SIGTERM)';
  }
  if (exitCode === 130) {
    return 'interrupted (SIGINT)';
  }
  if (exitCode > 128) {
    return `killed by signal ${exitCode - 128}`;
  }
  return `error code ${exitCode}`;
}
