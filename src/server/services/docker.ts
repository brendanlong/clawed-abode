import Docker from 'dockerode';
import { Readable } from 'stream';
import { env } from '@/lib/env';

const docker = new Docker();

// Logging helper for debugging
function log(context: string, message: string, data?: Record<string, unknown>): void {
  const timestamp = new Date().toISOString();
  const dataStr = data ? ` ${JSON.stringify(data)}` : '';
  console.log(`[${timestamp}] [docker:${context}] ${message}${dataStr}`);
}

const CLAUDE_CODE_IMAGE = 'claude-code-runner:latest';

export interface ContainerConfig {
  sessionId: string;
  workspacePath: string;
  githubToken?: string;
}

export async function createAndStartContainer(config: ContainerConfig): Promise<string> {
  const containerName = `claude-session-${config.sessionId}`;

  // Check if container already exists
  const existingContainers = await docker.listContainers({
    all: true,
    filters: { name: [containerName] },
  });

  if (existingContainers.length > 0) {
    const existing = existingContainers[0];
    if (existing.State !== 'running') {
      const container = docker.getContainer(existing.Id);
      await container.start();
    }
    return existing.Id;
  }

  // Build environment variables
  const envVars: string[] = [];
  if (config.githubToken) {
    envVars.push(`GITHUB_TOKEN=${config.githubToken}`);
  }

  const container = await docker.createContainer({
    Image: CLAUDE_CODE_IMAGE,
    name: containerName,
    Env: envVars,
    HostConfig: {
      Binds: [
        `${config.workspacePath}:/workspace`,
        `/var/run/docker.sock:/var/run/docker.sock`,
        `${env.CLAUDE_AUTH_PATH}:/home/claudeuser/.claude`,
      ],
      DeviceRequests: [
        {
          Driver: 'nvidia',
          Count: -1, // all GPUs
          Capabilities: [['gpu']],
        },
      ],
    },
    WorkingDir: '/workspace',
  });

  await container.start();

  // Configure git credential helper if token is provided
  if (config.githubToken) {
    await configureGitCredentials(container.id);
  }

  return container.id;
}

async function configureGitCredentials(containerId: string): Promise<void> {
  const container = docker.getContainer(containerId);

  // Configure git to use a credential helper that reads from GITHUB_TOKEN env var
  // This script echoes the token for GitHub URLs
  // Note: git sends multiple lines (protocol=https, host=github.com, etc.)
  // so we must read all input with cat, not just one line with read
  const credentialHelper = `#!/bin/sh
if [ "$1" = "get" ]; then
  input=$(cat)
  if echo "$input" | grep -q "host=github.com"; then
    echo "protocol=https"
    echo "host=github.com"
    echo "username=x-access-token"
    echo "password=$GITHUB_TOKEN"
  fi
fi`;

  // Write credential helper script
  const writeExec = await container.exec({
    Cmd: [
      'sh',
      '-c',
      `cat > /home/claudeuser/.git-credential-helper << 'SCRIPT'\n${credentialHelper}\nSCRIPT`,
    ],
    AttachStdout: true,
    AttachStderr: true,
    User: 'claudeuser',
  });
  await execAndWait(writeExec);

  // Make it executable
  const chmodExec = await container.exec({
    Cmd: ['chmod', '+x', '/home/claudeuser/.git-credential-helper'],
    AttachStdout: true,
    AttachStderr: true,
    User: 'claudeuser',
  });
  await execAndWait(chmodExec);

  // Configure git to use the credential helper
  const gitConfigExec = await container.exec({
    Cmd: [
      'git',
      'config',
      '--global',
      'credential.helper',
      '/home/claudeuser/.git-credential-helper',
    ],
    AttachStdout: true,
    AttachStderr: true,
    User: 'claudeuser',
  });
  await execAndWait(gitConfigExec);
}

async function execAndWait(exec: Docker.Exec): Promise<void> {
  const stream = await exec.start({ Detach: false, Tty: false });
  await new Promise<void>((resolve) => {
    stream.on('end', resolve);
    stream.on('error', resolve);
    stream.resume(); // Consume the stream
  });
}

export async function stopContainer(containerId: string): Promise<void> {
  const container = docker.getContainer(containerId);
  try {
    await container.stop({ t: 10 });
  } catch (error) {
    // Container might already be stopped
    if (!(error instanceof Error && error.message.includes('not running'))) {
      throw error;
    }
  }
}

export async function removeContainer(containerId: string): Promise<void> {
  const container = docker.getContainer(containerId);
  try {
    await container.stop({ t: 5 });
  } catch {
    // Ignore stop errors
  }
  try {
    await container.remove({ force: true });
  } catch {
    // Ignore remove errors if already removed
  }
}

export async function execInContainer(
  containerId: string,
  command: string[]
): Promise<{ stream: Readable; execId: string }> {
  const container = docker.getContainer(containerId);

  const exec = await container.exec({
    Cmd: command,
    AttachStdout: true,
    AttachStderr: true,
    Tty: false,
  });

  const stream = await exec.start({ Detach: false, Tty: false });

  return { stream: stream as unknown as Readable, execId: exec.id };
}

export async function getContainerStatus(
  containerId: string
): Promise<'running' | 'stopped' | 'not_found'> {
  try {
    const container = docker.getContainer(containerId);
    const info = await container.inspect();
    return info.State.Running ? 'running' : 'stopped';
  } catch {
    return 'not_found';
  }
}

export async function sendSignalToExec(
  containerId: string,
  pid: number,
  signal: string = 'SIGINT'
): Promise<void> {
  const container = docker.getContainer(containerId);

  const exec = await container.exec({
    Cmd: ['kill', `-${signal}`, pid.toString()],
    AttachStdout: true,
    AttachStderr: true,
  });

  await exec.start({ Detach: false });
}

export async function findProcessInContainer(
  containerId: string,
  processName: string
): Promise<number | null> {
  const container = docker.getContainer(containerId);

  const exec = await container.exec({
    Cmd: ['pgrep', '-f', processName],
    AttachStdout: true,
    AttachStderr: true,
  });

  const stream = await exec.start({ Detach: false });

  return new Promise((resolve) => {
    let output = '';
    stream.on('data', (chunk: Buffer) => {
      output += chunk.toString();
    });
    stream.on('end', () => {
      const pid = parseInt(output.trim().split('\n')[0], 10);
      const result = isNaN(pid) ? null : pid;
      log('findProcessInContainer', 'Search complete', {
        containerId,
        processName,
        pid: result,
        rawOutput: output.trim().slice(0, 50),
      });
      resolve(result);
    });
    stream.on('error', () => {
      log('findProcessInContainer', 'Stream error', { containerId, processName });
      resolve(null);
    });
  });
}

/**
 * Check if a specific process is running in a container
 */
export async function isProcessRunning(containerId: string, processName: string): Promise<boolean> {
  const pid = await findProcessInContainer(containerId, processName);
  return pid !== null;
}

/**
 * Execute a command in the background that writes output to a file.
 * Returns the exec ID for reference.
 */
export async function execInContainerWithOutputFile(
  containerId: string,
  command: string[],
  outputFile: string
): Promise<{ execId: string }> {
  log('execInContainerWithOutputFile', 'Starting', { containerId, command, outputFile });
  const container = docker.getContainer(containerId);

  // Wrap the command to redirect output to a file
  // Use sh -c to handle the redirection
  const wrappedCommand = [
    'sh',
    '-c',
    `${command.map(escapeShellArg).join(' ')} > "${outputFile}" 2>&1`,
  ];
  log('execInContainerWithOutputFile', 'Wrapped command', { wrappedCommand });

  const exec = await container.exec({
    Cmd: wrappedCommand,
    AttachStdout: false,
    AttachStderr: false,
    Tty: false,
  });

  // Start in detached mode
  await exec.start({ Detach: true, Tty: false });
  log('execInContainerWithOutputFile', 'Started in detached mode', { execId: exec.id });

  return { execId: exec.id };
}

/**
 * Tail a file in a container, streaming new content as it's written.
 * Returns a readable stream of the file content.
 */
export async function tailFileInContainer(
  containerId: string,
  filePath: string,
  startLine: number = 0
): Promise<{ stream: Readable; execId: string }> {
  log('tailFileInContainer', 'Starting', { containerId, filePath, startLine });
  const container = docker.getContainer(containerId);

  // Use tail -f to follow the file, starting from line N
  // +1 because tail uses 1-based line numbers and we want to skip 'startLine' lines
  const tailCmd = ['tail', '-n', `+${startLine + 1}`, '-f', filePath];
  log('tailFileInContainer', 'Running tail command', { tailCmd });

  const exec = await container.exec({
    Cmd: tailCmd,
    AttachStdout: true,
    AttachStderr: true,
    Tty: false,
  });

  const stream = await exec.start({ Detach: false, Tty: false });
  log('tailFileInContainer', 'Tail stream started', { execId: exec.id });

  return { stream: stream as unknown as Readable, execId: exec.id };
}

/**
 * Read the current contents of a file in a container.
 * Useful for catching up on missed output after reconnecting.
 */
export async function readFileInContainer(containerId: string, filePath: string): Promise<string> {
  const container = docker.getContainer(containerId);

  const exec = await container.exec({
    Cmd: ['cat', filePath],
    AttachStdout: true,
    AttachStderr: true,
    Tty: false,
  });

  const stream = await exec.start({ Detach: false, Tty: false });

  return new Promise((resolve, reject) => {
    let output = '';
    stream.on('data', (chunk: Buffer) => {
      // Strip Docker header if present
      output += stripDockerStreamHeader(chunk);
    });
    stream.on('end', () => resolve(output));
    stream.on('error', reject);
  });
}

/**
 * Count lines in a file in a container
 */
export async function countLinesInContainer(
  containerId: string,
  filePath: string
): Promise<number> {
  const container = docker.getContainer(containerId);

  const exec = await container.exec({
    Cmd: ['wc', '-l', filePath],
    AttachStdout: true,
    AttachStderr: true,
    Tty: false,
  });

  const stream = await exec.start({ Detach: false, Tty: false });

  return new Promise((resolve, reject) => {
    let output = '';
    stream.on('data', (chunk: Buffer) => {
      output += stripDockerStreamHeader(chunk);
    });
    stream.on('end', () => {
      const lineCount = parseInt(output.trim().split(/\s+/)[0], 10);
      resolve(isNaN(lineCount) ? 0 : lineCount);
    });
    stream.on('error', reject);
  });
}

/**
 * Check if a file exists in a container
 */
export async function fileExistsInContainer(
  containerId: string,
  filePath: string
): Promise<boolean> {
  const container = docker.getContainer(containerId);

  const exec = await container.exec({
    Cmd: ['test', '-f', filePath],
    AttachStdout: true,
    AttachStderr: true,
    Tty: false,
  });

  const stream = await exec.start({ Detach: false, Tty: false });

  return new Promise((resolve) => {
    stream.on('end', async () => {
      try {
        const info = await exec.inspect();
        const exists = info.ExitCode === 0;
        log('fileExistsInContainer', 'Check complete', { containerId, filePath, exists });
        resolve(exists);
      } catch {
        log('fileExistsInContainer', 'Check failed', { containerId, filePath });
        resolve(false);
      }
    });
    stream.on('error', () => {
      log('fileExistsInContainer', 'Stream error', { containerId, filePath });
      resolve(false);
    });
  });
}

function escapeShellArg(arg: string): string {
  // Escape single quotes and wrap in single quotes
  return `'${arg.replace(/'/g, "'\\''")}'`;
}

function stripDockerStreamHeader(chunk: Buffer): string {
  // Docker multiplexed streams have an 8-byte header
  // [stream type (1), 0, 0, 0, size (4 bytes big-endian)]
  if (chunk.length > 8) {
    const streamType = chunk[0];
    if (streamType === 1 || streamType === 2) {
      // stdout or stderr
      return chunk.slice(8).toString('utf-8');
    }
  }
  return chunk.toString('utf-8');
}
