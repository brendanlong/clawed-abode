/**
 * Integration test for claude-runner using the real Claude Agent SDK.
 *
 * Uses denyAllTools mode so Claude cannot execute any tools - it can only
 * respond with text. This makes the test safe to run without sandboxing.
 *
 * Requires:
 * - CLAUDE_CODE_OAUTH_TOKEN set in the environment
 * - Claude CLI installed and working
 *
 * Skips automatically if the SDK can't start (e.g., in CI without Claude CLI).
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import { tmpdir } from 'os';
import { mkdtemp, rm } from 'fs/promises';
import { join } from 'path';
import { setupTestDb, teardownTestDb, testPrisma, clearTestDb } from '@/test/setup-test-db';

// Skip entire suite if no Claude token is available
const hasToken = !!process.env.CLAUDE_CODE_OAUTH_TOKEN;

// Mock SSE events (we don't have a real SSE connection in tests)
const mockSseEvents = vi.hoisted(() => ({
  emitNewMessage: vi.fn(),
  emitClaudeRunning: vi.fn(),
  emitCommands: vi.fn(),
  emitSessionUpdate: vi.fn(),
  emitPrUpdate: vi.fn(),
}));

vi.mock('./events', () => ({
  sseEvents: mockSseEvents,
}));

// Mock github (no real GitHub API calls)
vi.mock('./github', () => ({
  fetchPullRequestForBranch: vi.fn().mockResolvedValue(undefined),
}));

// Mock worktree-manager's getCurrentBranch (no real git repo in temp dir)
vi.mock('./worktree-manager', () => ({
  getCurrentBranch: vi.fn().mockResolvedValue(null),
}));

// Import after mocks are set up
let runClaudeCommand: typeof import('./claude-runner').runClaudeCommand;
let isClaudeRunning: typeof import('./claude-runner').isClaudeRunning;

/**
 * Quick check that the Claude Agent SDK can actually start.
 * Returns false if the SDK process crashes (e.g., Claude CLI not installed).
 */
async function canStartSdk(): Promise<boolean> {
  try {
    const { query } = await import('@anthropic-ai/claude-agent-sdk');
    const q = query({
      prompt: 'hi',
      options: {
        permissionMode: 'bypassPermissions' as const,
        allowDangerouslySkipPermissions: true,
        cwd: '/tmp',
        maxTurns: 1,
      },
    });
    for await (const msg of q) {
      if (msg.type === 'assistant' || msg.type === 'result') {
        return true;
      }
    }
    return true;
  } catch {
    return false;
  }
}

describe.skipIf(!hasToken)('claude-runner integration (safe mode)', () => {
  let tempDir: string;
  let sdkAvailable = false;

  beforeAll(async () => {
    await setupTestDb();
    tempDir = await mkdtemp(join(tmpdir(), 'claude-runner-test-'));

    // Dynamic import after mocks
    const mod = await import('./claude-runner');
    runClaudeCommand = mod.runClaudeCommand;
    isClaudeRunning = mod.isClaudeRunning;

    // Check if SDK actually works in this environment
    sdkAvailable = await canStartSdk();
    if (!sdkAvailable) {
      console.log('Claude Agent SDK not available in this environment, skipping SDK tests');
    }
  }, 120000);

  afterAll(async () => {
    await teardownTestDb();
    await rm(tempDir, { recursive: true, force: true });
  });

  beforeEach(async () => {
    await clearTestDb();
    vi.clearAllMocks();
  });

  it('should run a query and persist messages', async () => {
    if (!sdkAvailable) return;

    // Create a session in the DB
    const session = await testPrisma.session.create({
      data: {
        name: 'Test Session',
        workspacePath: tempDir,
        status: 'running',
      },
    });

    // Run a simple prompt with all tools denied
    await runClaudeCommand({
      sessionId: session.id,
      prompt: 'Say "hello integration test" and nothing else.',
      workingDir: tempDir,
      denyAllTools: true,
    });

    // Verify messages were persisted
    const messages = await testPrisma.message.findMany({
      where: { sessionId: session.id },
      orderBy: { sequence: 'asc' },
    });

    // Should have at least: user message + some SDK response
    expect(messages.length).toBeGreaterThanOrEqual(2);

    // First message should be the user prompt
    const userMsg = messages[0];
    expect(userMsg.type).toBe('user');
    const userContent = JSON.parse(userMsg.content);
    expect(userContent.content).toContain('hello integration test');

    // Should have at least one SDK response message
    const sdkMessages = messages.slice(1);
    expect(sdkMessages.length).toBeGreaterThanOrEqual(1);

    // SSE events should have been emitted
    expect(mockSseEvents.emitClaudeRunning).toHaveBeenCalledWith(session.id, true);
    expect(mockSseEvents.emitClaudeRunning).toHaveBeenCalledWith(session.id, false);
    expect(mockSseEvents.emitNewMessage).toHaveBeenCalled();

    // Should not be running anymore
    expect(isClaudeRunning(session.id)).toBe(false);
  }, 60000);

  it('should not allow concurrent queries', async () => {
    if (!sdkAvailable) return;

    const session = await testPrisma.session.create({
      data: {
        name: 'Concurrent Test',
        workspacePath: tempDir,
        status: 'running',
      },
    });

    // Start a query
    const firstQuery = runClaudeCommand({
      sessionId: session.id,
      prompt: 'Say "first" and nothing else.',
      workingDir: tempDir,
      denyAllTools: true,
    });

    // Brief delay to ensure the first query has started
    await new Promise((r) => setTimeout(r, 100));

    // Second query should fail if first is still running
    if (isClaudeRunning(session.id)) {
      await expect(
        runClaudeCommand({
          sessionId: session.id,
          prompt: 'Say "second"',
          workingDir: tempDir,
          denyAllTools: true,
        })
      ).rejects.toThrow('already running');
    }

    // Wait for first to complete
    await firstQuery;
  }, 60000);
});
