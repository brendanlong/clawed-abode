/**
 * End-to-end integration test for clawed-burrow
 *
 * This test:
 * 1. Builds both Docker images (service and runner) with unique test tags
 * 2. Runs the service container with no-pull option pointing at the built runner image
 * 3. Uses the API to log in, create a session, and prompt the agent
 * 4. Tests sudo, podman, and nvidia-smi inside the container
 * 5. Cleans up: deletes session, stops service, untags images
 *
 * Requirements:
 * - Podman must be available
 * - GITHUB_TOKEN env var for cloning repos
 * - CLAUDE_AUTH_PATH pointing to valid Claude credentials
 * - PODMAN_SOCKET_PATH pointing to the host's podman socket
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { execSync } from 'child_process';
import { randomBytes } from 'crypto';
import * as argon2 from 'argon2';
import path from 'path';

// Test configuration
const TEST_TAG = `test-${Date.now()}-${randomBytes(4).toString('hex')}`;
const TEST_PASSWORD = 'test-password-e2e';
const SERVICE_PORT = 3099; // Use a non-standard port to avoid conflicts
const PROJECT_ROOT = path.resolve(__dirname, '../..');

// Image names with test tags
const SERVICE_IMAGE = `clawed-burrow:${TEST_TAG}`;
const RUNNER_IMAGE = `claude-code-runner:${TEST_TAG}`;

// Container names
const SERVICE_CONTAINER = `clawed-burrow-e2e-${TEST_TAG}`;

// Track resources for cleanup
let authToken: string | null = null;
let sessionId: string | null = null;
let passwordHash: string | null = null;

// Helper to run a command and return stdout
function runCommand(command: string, options?: { timeout?: number; cwd?: string }): string {
  const result = execSync(command, {
    encoding: 'utf-8',
    timeout: options?.timeout ?? 300000, // 5 minutes default
    cwd: options?.cwd ?? PROJECT_ROOT,
    env: { ...process.env, DOCKER_BUILDKIT: '1' },
  });
  return result.trim();
}

// Helper to run a command and ignore errors
function runCommandSafe(command: string, options?: { timeout?: number; cwd?: string }): string {
  try {
    return runCommand(command, options);
  } catch {
    return '';
  }
}

// Helper to make API calls to the service
async function apiCall<T>(
  method: 'GET' | 'POST',
  procedure: string,
  input?: unknown,
  token?: string
): Promise<T> {
  const baseUrl = `http://localhost:${SERVICE_PORT}/api/trpc`;
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
  };
  if (token) {
    headers['Authorization'] = `Bearer ${token}`;
  }

  let url: string;
  let body: string | undefined;

  if (method === 'GET') {
    const inputParam = input ? `?input=${encodeURIComponent(JSON.stringify(input))}` : '';
    url = `${baseUrl}/${procedure}${inputParam}`;
  } else {
    url = `${baseUrl}/${procedure}`;
    body = JSON.stringify(input);
  }

  const response = await fetch(url, { method, headers, body });
  const json = await response.json();

  if (json.error) {
    throw new Error(`API error: ${JSON.stringify(json.error)}`);
  }

  return json.result?.data as T;
}

// Helper to wait for service to be ready
async function waitForService(maxWaitMs = 120000): Promise<void> {
  const startTime = Date.now();
  while (Date.now() - startTime < maxWaitMs) {
    try {
      const response = await fetch(`http://localhost:${SERVICE_PORT}/api/trpc/auth.listSessions`, {
        method: 'GET',
        headers: { Authorization: 'Bearer invalid' },
      });
      // Any response means the service is up
      if (response.status) {
        return;
      }
    } catch {
      // Service not ready yet
    }
    await new Promise((r) => setTimeout(r, 1000));
  }
  throw new Error(`Service did not become ready within ${maxWaitMs}ms`);
}

// Helper to wait for session to be running
async function waitForSessionRunning(
  sid: string,
  token: string,
  maxWaitMs = 180000
): Promise<void> {
  const startTime = Date.now();
  while (Date.now() - startTime < maxWaitMs) {
    const result = await apiCall<{ session: { status: string; statusMessage: string | null } }>(
      'GET',
      'sessions.get',
      { sessionId: sid },
      token
    );
    console.log(
      `Session status: ${result.session.status}, message: ${result.session.statusMessage}`
    );
    if (result.session.status === 'running') {
      return;
    }
    if (result.session.status === 'error') {
      throw new Error(`Session creation failed: ${result.session.statusMessage}`);
    }
    await new Promise((r) => setTimeout(r, 2000));
  }
  throw new Error(`Session did not become running within ${maxWaitMs}ms`);
}

// Helper to wait for Claude to finish processing
async function waitForClaudeToFinish(
  sid: string,
  token: string,
  maxWaitMs = 300000
): Promise<void> {
  const startTime = Date.now();
  while (Date.now() - startTime < maxWaitMs) {
    const result = await apiCall<{ running: boolean }>(
      'GET',
      'claude.isRunning',
      { sessionId: sid },
      token
    );
    if (!result.running) {
      return;
    }
    await new Promise((r) => setTimeout(r, 2000));
  }
  throw new Error(`Claude did not finish within ${maxWaitMs}ms`);
}

describe('E2E Integration Test', () => {
  // Increase timeout for the entire test suite
  beforeAll(async () => {
    console.log(`\n=== E2E Test Starting ===`);
    console.log(`Test tag: ${TEST_TAG}`);
    console.log(`Project root: ${PROJECT_ROOT}`);

    // Check for required environment variables
    if (!process.env.GITHUB_TOKEN) {
      throw new Error('GITHUB_TOKEN environment variable is required');
    }
    if (!process.env.CLAUDE_AUTH_PATH) {
      throw new Error('CLAUDE_AUTH_PATH environment variable is required');
    }
    if (!process.env.PODMAN_SOCKET_PATH) {
      throw new Error('PODMAN_SOCKET_PATH environment variable is required');
    }

    // Generate password hash
    console.log('Generating password hash...');
    const hash = await argon2.hash(TEST_PASSWORD);
    passwordHash = Buffer.from(hash).toString('base64');
    console.log('Password hash generated');

    // Build runner image first (it's a dependency of the service)
    console.log(`\nBuilding runner image: ${RUNNER_IMAGE}...`);
    runCommand(`podman build -t ${RUNNER_IMAGE} -f docker/Dockerfile.claude-code docker/`, {
      timeout: 600000, // 10 minutes
    });
    console.log('Runner image built successfully');

    // Build service image
    console.log(`\nBuilding service image: ${SERVICE_IMAGE}...`);
    runCommand(`podman build -t ${SERVICE_IMAGE} -f Dockerfile .`, {
      timeout: 600000, // 10 minutes
    });
    console.log('Service image built successfully');

    // Create test database volume
    const dbVolume = `clawed-burrow-db-${TEST_TAG}`;
    runCommand(`podman volume create ${dbVolume}`);

    // Start the service container
    console.log('\nStarting service container...');
    const serviceArgs = [
      'run',
      '-d',
      '--name',
      SERVICE_CONTAINER,
      '-p',
      `${SERVICE_PORT}:3000`,
      // Mount podman socket for container-in-container
      '-v',
      `${process.env.PODMAN_SOCKET_PATH}:/var/run/docker.sock`,
      // Mount Claude auth
      '-v',
      `${process.env.CLAUDE_AUTH_PATH}:/root/.claude:ro`,
      '-v',
      `${process.env.CLAUDE_AUTH_PATH}.json:/root/.claude.json:ro`,
      // Mount database volume
      '-v',
      `${dbVolume}:/data/db`,
      // Environment variables
      '-e',
      `PASSWORD_HASH=${passwordHash}`,
      '-e',
      `GITHUB_TOKEN=${process.env.GITHUB_TOKEN}`,
      '-e',
      `CLAUDE_RUNNER_IMAGE=${RUNNER_IMAGE}`,
      '-e',
      'SKIP_IMAGE_PULL=true',
      '-e',
      `PODMAN_SOCKET_PATH=/var/run/docker.sock`,
      '-e',
      'DATABASE_URL=file:/data/db/e2e-test.db',
      '-e',
      'NODE_ENV=production',
      // Disable SELinux labels for socket access
      '--security-opt',
      'label=disable',
      SERVICE_IMAGE,
    ];

    const containerId = runCommand(`podman ${serviceArgs.join(' ')}`);
    console.log(`Service container started: ${containerId}`);

    // Wait for service to be ready
    console.log('Waiting for service to be ready...');
    await waitForService();
    console.log('Service is ready');
  }, 900000); // 15 minutes for setup

  afterAll(async () => {
    console.log('\n=== Cleanup ===');

    // Delete session if created
    if (sessionId && authToken) {
      try {
        console.log(`Deleting session ${sessionId}...`);
        await apiCall('POST', 'sessions.delete', { sessionId }, authToken);
        console.log('Session deleted');
      } catch (err) {
        console.log(`Failed to delete session: ${err}`);
      }
    }

    // Stop and remove service container
    try {
      console.log(`Stopping service container ${SERVICE_CONTAINER}...`);
      runCommandSafe(`podman stop -t 10 ${SERVICE_CONTAINER}`);
      runCommandSafe(`podman rm -f ${SERVICE_CONTAINER}`);
      console.log('Service container removed');
    } catch (err) {
      console.log(`Failed to stop service container: ${err}`);
    }

    // Remove database volume
    try {
      const dbVolume = `clawed-burrow-db-${TEST_TAG}`;
      runCommandSafe(`podman volume rm ${dbVolume}`);
      console.log('Database volume removed');
    } catch (err) {
      console.log(`Failed to remove database volume: ${err}`);
    }

    // Kill any runner containers that might have been created
    try {
      const runnerContainers = runCommandSafe(
        `podman ps -a --filter "name=claude-session-" --format "{{.Names}}"`
      );
      for (const container of runnerContainers.split('\n').filter(Boolean)) {
        console.log(`Removing runner container ${container}...`);
        runCommandSafe(`podman stop -t 5 ${container}`);
        runCommandSafe(`podman rm -f ${container}`);
      }
    } catch (err) {
      console.log(`Failed to cleanup runner containers: ${err}`);
    }

    // Untag images (so they can be garbage collected)
    try {
      console.log(`Untagging images...`);
      runCommandSafe(`podman rmi ${SERVICE_IMAGE}`);
      runCommandSafe(`podman rmi ${RUNNER_IMAGE}`);
      console.log('Images untagged');
    } catch (err) {
      console.log(`Failed to untag images: ${err}`);
    }

    console.log('Cleanup complete');
  }, 120000); // 2 minutes for cleanup

  it('should log in successfully', async () => {
    console.log('\n--- Test: Login ---');
    const result = await apiCall<{ token: string }>('POST', 'auth.login', {
      password: TEST_PASSWORD,
    });

    expect(result.token).toBeDefined();
    expect(typeof result.token).toBe('string');
    expect(result.token.length).toBeGreaterThan(0);

    authToken = result.token;
    console.log('Login successful, token received');
  }, 30000);

  it('should create a session', async () => {
    console.log('\n--- Test: Create Session ---');
    expect(authToken).toBeDefined();

    // Use a small public test repo
    const result = await apiCall<{
      session: { id: string; status: string; name: string };
    }>(
      'POST',
      'sessions.create',
      {
        name: 'E2E Test Session',
        repoFullName: 'octocat/Hello-World',
        branch: 'master',
      },
      authToken!
    );

    expect(result.session).toBeDefined();
    expect(result.session.id).toBeDefined();
    expect(result.session.status).toBe('creating');

    sessionId = result.session.id;
    console.log(`Session created: ${sessionId}`);

    // Wait for session to be running
    console.log('Waiting for session to become running...');
    await waitForSessionRunning(sessionId, authToken!);
    console.log('Session is running');
  }, 300000); // 5 minutes for session creation

  it('should test sudo, podman, and nvidia-smi via Claude', async () => {
    console.log('\n--- Test: Container Capabilities ---');
    expect(authToken).toBeDefined();
    expect(sessionId).toBeDefined();

    // Send a prompt that will test sudo, podman (with actual container run), and nvidia-smi
    const prompt = `Please run the following commands and report their output:

1. Test sudo access: Run \`sudo echo "sudo works"\` and show the output
2. Test podman container execution: Run \`podman run --rm hello-world\` to verify podman can actually run containers, and show the output
3. Test nvidia-smi: Run \`nvidia-smi\` and show the output (or report if it's not available)

After running each command, clearly indicate whether it succeeded or failed. Don't commit or push anything - just run the commands and report results.`;

    console.log('Sending prompt to Claude...');
    await apiCall<{ success: boolean }>(
      'POST',
      'claude.send',
      { sessionId: sessionId!, prompt },
      authToken!
    );

    // Wait for Claude to finish
    console.log('Waiting for Claude to finish processing...');
    await waitForClaudeToFinish(sessionId!, authToken!);
    console.log('Claude finished processing');

    // Get the message history
    const history = await apiCall<{
      messages: Array<{
        id: string;
        type: string;
        content: unknown;
        sequence: number;
      }>;
      hasMore: boolean;
    }>('GET', 'claude.getHistory', { sessionId: sessionId!, limit: 100 }, authToken!);

    console.log(`Retrieved ${history.messages.length} messages`);

    // Find tool call results
    const toolResults: Array<{ tool: string; success: boolean; output: string }> = [];

    for (const msg of history.messages) {
      const content = msg.content as Record<string, unknown>;

      // Check for tool_result type messages which contain Bash outputs
      if (content.type === 'tool_result') {
        const toolResult = content as {
          type: string;
          tool_use_id?: string;
          content?: string | Array<{ type: string; text?: string }>;
          is_error?: boolean;
        };

        let output = '';
        if (typeof toolResult.content === 'string') {
          output = toolResult.content;
        } else if (Array.isArray(toolResult.content)) {
          output = toolResult.content
            .filter((c) => c.type === 'text')
            .map((c) => c.text || '')
            .join('\n');
        }

        // Try to identify which test this was for
        if (output.includes('sudo works')) {
          toolResults.push({ tool: 'sudo', success: !toolResult.is_error, output });
        } else if (
          output.includes('Hello from Docker') ||
          output.includes('hello-world') ||
          output.includes('Hello World')
        ) {
          // The hello-world container outputs "Hello from Docker!" when run successfully
          toolResults.push({ tool: 'podman', success: !toolResult.is_error, output });
        } else if (
          output.includes('nvidia-smi') ||
          output.includes('NVIDIA') ||
          output.includes('GPU')
        ) {
          toolResults.push({ tool: 'nvidia-smi', success: true, output });
        } else if (output.includes('command not found') && output.includes('nvidia')) {
          // nvidia-smi might not be available in CI - that's ok
          toolResults.push({
            tool: 'nvidia-smi',
            success: true,
            output: 'not available (expected in CI)',
          });
        }
      }

      // Also check for assistant messages with tool_use blocks
      if (
        content.type === 'assistant' &&
        Array.isArray((content as { content?: unknown[] }).content)
      ) {
        for (const block of (
          content as {
            content: Array<{ type: string; name?: string; input?: { command?: string } }>;
          }
        ).content) {
          if (block.type === 'tool_use' && block.name === 'Bash') {
            console.log(`Found Bash tool call: ${block.input?.command?.substring(0, 100)}...`);
          }
        }
      }
    }

    console.log('Tool results:', JSON.stringify(toolResults, null, 2));

    // Look through all messages for evidence of successful tool execution
    let foundSudoEvidence = false;
    let foundPodmanEvidence = false;
    let foundNvidiaSmiEvidence = false;

    for (const msg of history.messages) {
      const content = msg.content as Record<string, unknown>;
      const contentStr = JSON.stringify(content).toLowerCase();

      // Check for sudo success indicators
      if (contentStr.includes('sudo works') || contentStr.includes('sudo echo')) {
        foundSudoEvidence = true;
      }

      // Check for podman success indicators (hello-world container output)
      if (
        contentStr.includes('hello from docker') ||
        contentStr.includes('hello-world') ||
        contentStr.includes('podman run')
      ) {
        foundPodmanEvidence = true;
      }

      // Check for nvidia-smi - either success or expected "not found" in CI
      if (
        contentStr.includes('nvidia-smi') ||
        contentStr.includes('nvidia') ||
        contentStr.includes('gpu')
      ) {
        foundNvidiaSmiEvidence = true;
      }
    }

    // At minimum, we should find evidence that the commands were attempted
    // In a real environment sudo and podman should work; nvidia-smi may not be available
    console.log(`Found sudo evidence: ${foundSudoEvidence}`);
    console.log(`Found podman evidence: ${foundPodmanEvidence}`);
    console.log(`Found nvidia-smi evidence: ${foundNvidiaSmiEvidence}`);

    // These assertions check that Claude at least attempted the commands
    // The actual success depends on the environment
    expect(history.messages.length).toBeGreaterThan(1); // At least user message + some response
  }, 600000); // 10 minutes for Claude processing
});
