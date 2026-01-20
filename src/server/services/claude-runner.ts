import {
  execInContainerWithOutputFile,
  tailFileInContainer,
  readFileInContainer,
  findProcessInContainer,
  sendSignalToExec,
  isProcessRunning,
  getContainerStatus,
  fileExistsInContainer,
} from './docker';
import { prisma } from '@/lib/prisma';
import { parseClaudeStreamLine, getMessageType } from '@/lib/claude-messages';
import { v4 as uuid } from 'uuid';

// Track running Claude processes per session (in-memory for quick lookups)
// The DB is the source of truth; this is for performance
const runningProcesses = new Map<string, { containerId: string; pid: number | null }>();

// Track active stream processors to avoid duplicate processing
const activeStreamProcessors = new Set<string>();

const OUTPUT_FILE_PREFIX = '.claude-output-';

// Logging helper for debugging
function log(context: string, message: string, data?: Record<string, unknown>): void {
  const timestamp = new Date().toISOString();
  const dataStr = data ? ` ${JSON.stringify(data)}` : '';
  console.log(`[${timestamp}] [claude-runner:${context}] ${message}${dataStr}`);
}

function getOutputFileName(sessionId: string): string {
  return `${OUTPUT_FILE_PREFIX}${sessionId}.jsonl`;
}

function getOutputFilePath(sessionId: string): string {
  return `/workspace/${getOutputFileName(sessionId)}`;
}

export async function runClaudeCommand(
  sessionId: string,
  containerId: string,
  prompt: string
): Promise<void> {
  log('runClaudeCommand', 'Starting', { sessionId, containerId, promptLength: prompt.length });

  // Check if session already has a running process (in-memory check first for speed)
  if (runningProcesses.has(sessionId)) {
    log('runClaudeCommand', 'Process already running in memory', { sessionId });
    throw new Error('A Claude process is already running for this session');
  }

  // Check DB for persistent record
  const existingProcess = await prisma.claudeProcess.findUnique({
    where: { sessionId },
  });
  if (existingProcess) {
    // Check if it's actually still running
    const stillRunning = await isProcessRunning(containerId, 'claude');
    if (stillRunning) {
      throw new Error('A Claude process is already running for this session');
    }
    // Clean up stale record
    await prisma.claudeProcess.delete({ where: { sessionId } });
  }

  // Get the next sequence number for this session
  const lastMessage = await prisma.message.findFirst({
    where: { sessionId },
    orderBy: { sequence: 'desc' },
    select: { sequence: true },
  });

  let sequence = (lastMessage?.sequence ?? -1) + 1;

  // Store the user prompt first
  await prisma.message.create({
    data: {
      id: uuid(),
      sessionId,
      sequence: sequence++,
      type: 'user',
      content: JSON.stringify({ type: 'user', content: prompt }),
    },
  });

  // Build the Claude command
  // Use --resume for subsequent messages, --session-id for the first
  const isFirstMessage = !lastMessage;
  const command = [
    'claude',
    '-p',
    prompt,
    ...(isFirstMessage ? ['--session-id', sessionId] : ['--resume', sessionId]),
    '--output-format',
    'stream-json',
    '--verbose',
    '--dangerously-skip-permissions',
  ];

  const outputFile = getOutputFilePath(sessionId);

  // Create persistent record before starting
  await prisma.claudeProcess.create({
    data: {
      sessionId,
      containerId,
      outputFile: getOutputFileName(sessionId),
      lastSequence: sequence - 1, // We've saved the user prompt
    },
  });

  runningProcesses.set(sessionId, { containerId, pid: null });
  log('runClaudeCommand', 'Process registered in memory', { sessionId });

  try {
    // Start Claude with output redirected to file
    log('runClaudeCommand', 'Executing command in container', { command, outputFile });
    await execInContainerWithOutputFile(containerId, command, outputFile);
    log('runClaudeCommand', 'Command started (detached)', { sessionId });

    // Small delay to let the file be created
    await new Promise((resolve) => setTimeout(resolve, 100));

    // Try to find the PID of the claude process
    setTimeout(async () => {
      const pid = await findProcessInContainer(containerId, 'claude');
      log('runClaudeCommand', 'PID lookup result', { sessionId, pid });
      const process = runningProcesses.get(sessionId);
      if (process && pid) {
        process.pid = pid;
      }
    }, 500);

    // Tail the output file and process it
    log('runClaudeCommand', 'Starting output file processing', {
      sessionId,
      outputFile,
      startSequence: sequence,
    });
    await processOutputFile(sessionId, containerId, outputFile, sequence);
    log('runClaudeCommand', 'Output file processing completed', { sessionId });
  } finally {
    runningProcesses.delete(sessionId);
    log('runClaudeCommand', 'Process cleanup', { sessionId });
    // Clean up the persistent record
    await prisma.claudeProcess.delete({ where: { sessionId } }).catch(() => {}); // Ignore if already deleted
  }
}

/**
 * Reconnect to an existing Claude process and continue processing its output.
 * Used after server restart to resume processing orphaned processes.
 */
export async function reconnectToClaudeProcess(
  sessionId: string
): Promise<{ reconnected: boolean; stillRunning: boolean }> {
  const processRecord = await prisma.claudeProcess.findUnique({
    where: { sessionId },
    include: { session: true },
  });

  if (!processRecord || !processRecord.session.containerId) {
    return { reconnected: false, stillRunning: false };
  }

  const containerId = processRecord.session.containerId;

  // Check if container is still running
  const containerStatus = await getContainerStatus(containerId);
  if (containerStatus !== 'running') {
    // Container stopped - just read remaining output
    await catchUpFromOutputFile(
      sessionId,
      containerId,
      getOutputFilePath(sessionId),
      processRecord.lastSequence
    );
    await prisma.claudeProcess.delete({ where: { sessionId } });
    return { reconnected: false, stillRunning: false };
  }

  // Check if Claude process is still running
  const claudeRunning = await isProcessRunning(containerId, 'claude');

  if (!claudeRunning) {
    // Process finished - just read remaining output
    await catchUpFromOutputFile(
      sessionId,
      containerId,
      getOutputFilePath(sessionId),
      processRecord.lastSequence
    );
    await prisma.claudeProcess.delete({ where: { sessionId } });
    return { reconnected: false, stillRunning: false };
  }

  // Process is still running - reconnect to it
  if (runningProcesses.has(sessionId) || activeStreamProcessors.has(sessionId)) {
    // Already being processed
    return { reconnected: true, stillRunning: true };
  }

  runningProcesses.set(sessionId, { containerId, pid: null });

  // Find the PID
  const pid = await findProcessInContainer(containerId, 'claude');
  if (pid) {
    const process = runningProcesses.get(sessionId);
    if (process) {
      process.pid = pid;
    }
  }

  // Start processing the output file in the background
  processOutputFile(
    sessionId,
    containerId,
    getOutputFilePath(sessionId),
    processRecord.lastSequence + 1
  )
    .finally(() => {
      runningProcesses.delete(sessionId);
      prisma.claudeProcess.delete({ where: { sessionId } }).catch(() => {});
    })
    .catch((err) => {
      console.error(`Error processing reconnected Claude output for ${sessionId}:`, err);
    });

  return { reconnected: true, stillRunning: true };
}

/**
 * Read any unprocessed output from the file and save to DB.
 * Used when process has finished but we missed some output.
 */
async function catchUpFromOutputFile(
  sessionId: string,
  containerId: string,
  outputFile: string,
  lastProcessedSequence: number
): Promise<void> {
  // Check if file exists
  const fileExists = await fileExistsInContainer(containerId, outputFile);
  if (!fileExists) {
    console.log(`Output file ${outputFile} not found for session ${sessionId}`);
    return;
  }

  const fileContent = await readFileInContainer(containerId, outputFile);
  const lines = fileContent.split('\n').filter((line) => line.trim());

  // Get current max sequence from DB to know where to start
  const lastMessage = await prisma.message.findFirst({
    where: { sessionId },
    orderBy: { sequence: 'desc' },
    select: { sequence: true },
  });

  let sequence = (lastMessage?.sequence ?? lastProcessedSequence) + 1;
  let linesProcessed = 0;

  // We need to figure out which lines we haven't processed yet.
  // Since lines don't have sequence numbers, we count from the last known sequence.
  // This is approximate but should work for catch-up scenarios.
  const linesToProcess = lines.slice(
    Math.max(0, (lastMessage?.sequence ?? 0) - lastProcessedSequence)
  );

  for (const line of linesToProcess) {
    if (!line.trim()) continue;

    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      // Save as error
      await prisma.message.create({
        data: {
          id: uuid(),
          sessionId,
          sequence: sequence++,
          type: 'system',
          content: JSON.stringify({
            type: 'system',
            subtype: 'error',
            content: [{ type: 'text', text: line }],
          }),
        },
      });
      linesProcessed++;
      continue;
    }

    const messageType = getMessageType(parsed);
    const msgId =
      (parsed as { uuid?: string; id?: string }).uuid ||
      (parsed as { uuid?: string; id?: string }).id ||
      uuid();

    // Use upsert to avoid duplicate key errors
    await prisma.message.upsert({
      where: {
        sessionId_sequence: { sessionId, sequence },
      },
      update: {},
      create: {
        id: msgId,
        sessionId,
        sequence: sequence++,
        type: messageType,
        content: line,
      },
    });
    linesProcessed++;
  }

  console.log(`Caught up ${linesProcessed} messages for session ${sessionId}`);
}

/**
 * Process the output file by tailing it and saving messages to DB.
 */
async function processOutputFile(
  sessionId: string,
  containerId: string,
  outputFile: string,
  startSequence: number
): Promise<void> {
  log('processOutputFile', 'Starting', { sessionId, outputFile, startSequence });

  if (activeStreamProcessors.has(sessionId)) {
    log('processOutputFile', 'Stream processor already active', { sessionId });
    throw new Error('Stream processor already active for this session');
  }

  activeStreamProcessors.add(sessionId);
  let sequence = startSequence;
  let buffer = '';
  let errorLines: string[] = [];
  let totalChunks = 0;
  let totalLines = 0;

  // Helper to save an error message
  const saveErrorMessage = async (errorText: string) => {
    const errorContent = JSON.stringify({
      type: 'system',
      subtype: 'error',
      content: [{ type: 'text', text: errorText }],
    });
    await prisma.message.create({
      data: {
        id: uuid(),
        sessionId,
        sequence: sequence++,
        type: 'system',
        content: errorContent,
      },
    });
    await updateLastSequence(sessionId, sequence - 1);
  };

  // Flush accumulated error lines as a single message
  const flushErrorLines = async () => {
    if (errorLines.length > 0) {
      const combinedError = errorLines.join('\n');
      console.error('Failed to parse Claude output:', combinedError);
      await saveErrorMessage(combinedError);
      errorLines = [];
    }
  };

  try {
    // Wait for file to exist (with timeout)
    log('processOutputFile', 'Waiting for output file to exist', { sessionId, outputFile });
    let attempts = 0;
    while (attempts < 50) {
      const exists = await fileExistsInContainer(containerId, outputFile);
      if (exists) {
        log('processOutputFile', 'Output file found', { sessionId, attempts });
        break;
      }
      await new Promise((resolve) => setTimeout(resolve, 100));
      attempts++;
    }
    if (attempts >= 50) {
      log('processOutputFile', 'Timeout waiting for output file', { sessionId, attempts });
    }

    log('processOutputFile', 'Starting tail', { sessionId, outputFile });
    const { stream } = await tailFileInContainer(containerId, outputFile, 0);
    log('processOutputFile', 'Tail started, listening for data', { sessionId });

    return new Promise((resolve, reject) => {
      stream.on('data', async (chunk: Buffer) => {
        totalChunks++;
        const data = stripDockerHeader(chunk);
        log('processOutputFile', 'Received chunk', {
          sessionId,
          chunkNumber: totalChunks,
          rawLength: chunk.length,
          strippedLength: data.length,
          preview: data.slice(0, 100),
        });
        buffer += data;

        // Process complete lines
        const lines = buffer.split('\n');
        buffer = lines.pop() || ''; // Keep incomplete line in buffer

        for (const line of lines) {
          if (!line.trim()) continue;
          totalLines++;

          let parsed: unknown;
          try {
            parsed = JSON.parse(line);
          } catch {
            // Accumulate unparseable lines to batch them together
            log('processOutputFile', 'Failed to parse line as JSON', {
              sessionId,
              line: line.slice(0, 200),
            });
            errorLines.push(line);
            continue;
          }

          // Flush any accumulated errors before saving valid message
          await flushErrorLines();

          // Validate the parsed JSON against our schemas
          const parseResult = parseClaudeStreamLine(parsed);
          const messageType = getMessageType(parsed);

          if (!parseResult.success) {
            console.warn(`Failed to validate ${messageType} message:`, parseResult.error);
          }

          // Extract ID from parsed content if available
          const msgId =
            (parsed as { uuid?: string; id?: string }).uuid ||
            (parsed as { uuid?: string; id?: string }).id ||
            uuid();

          log('processOutputFile', 'Saving message to DB', {
            sessionId,
            sequence,
            messageType,
            msgId,
          });

          await prisma.message.create({
            data: {
              id: msgId,
              sessionId,
              sequence: sequence++,
              type: messageType,
              content: line,
            },
          });

          // Update last processed sequence
          await updateLastSequence(sessionId, sequence - 1);
        }
      });

      // Poll for process completion since tail -f won't end on its own
      let pollCount = 0;
      const pollInterval = setInterval(async () => {
        pollCount++;
        const stillRunning = await isProcessRunning(containerId, 'claude');
        log('processOutputFile', 'Process poll', {
          sessionId,
          pollCount,
          stillRunning,
          totalChunks,
          totalLines,
        });
        if (!stillRunning) {
          log('processOutputFile', 'Process finished, cleaning up', {
            sessionId,
            totalChunks,
            totalLines,
          });
          clearInterval(pollInterval);
          // Give a moment for final output to be written
          await new Promise((r) => setTimeout(r, 500));
          // Read any remaining content
          await flushErrorLines();
          stream.destroy();
          resolve();
        }
      }, 1000);

      stream.on('error', async (err) => {
        log('processOutputFile', 'Stream error', { sessionId, error: err.message });
        clearInterval(pollInterval);
        await flushErrorLines();
        await saveErrorMessage(`Stream error: ${err.message}`);
        reject(err);
      });

      stream.on('close', async () => {
        log('processOutputFile', 'Stream closed', { sessionId, totalChunks, totalLines });
        clearInterval(pollInterval);
        await flushErrorLines();
        resolve();
      });
    });
  } finally {
    log('processOutputFile', 'Finished', { sessionId, totalChunks, totalLines });
    activeStreamProcessors.delete(sessionId);
  }
}

async function updateLastSequence(sessionId: string, sequence: number): Promise<void> {
  await prisma.claudeProcess
    .update({
      where: { sessionId },
      data: { lastSequence: sequence },
    })
    .catch(() => {}); // Ignore if record doesn't exist
}

function stripDockerHeader(chunk: Buffer): string {
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

export async function interruptClaude(sessionId: string): Promise<boolean> {
  const process = runningProcesses.get(sessionId);

  if (!process) {
    // Check DB for persistent record
    const processRecord = await prisma.claudeProcess.findUnique({
      where: { sessionId },
    });
    if (!processRecord) {
      return false;
    }

    // Try to find and kill the process
    const pid = await findProcessInContainer(processRecord.containerId, 'claude');
    if (pid) {
      await sendSignalToExec(processRecord.containerId, pid, 'SIGINT');
      return true;
    }
    return false;
  }

  if (process.pid) {
    await sendSignalToExec(process.containerId, process.pid, 'SIGINT');
    return true;
  }

  // Try to find the process if PID wasn't captured earlier
  const pid = await findProcessInContainer(process.containerId, 'claude');
  if (pid) {
    await sendSignalToExec(process.containerId, pid, 'SIGINT');
    return true;
  }

  return false;
}

export function isClaudeRunning(sessionId: string): boolean {
  return runningProcesses.has(sessionId);
}

/**
 * Check if Claude is running, including checking the DB for persistent records.
 * More thorough than isClaudeRunning() but involves a DB query.
 */
export async function isClaudeRunningAsync(sessionId: string): Promise<boolean> {
  if (runningProcesses.has(sessionId)) {
    return true;
  }

  const processRecord = await prisma.claudeProcess.findUnique({
    where: { sessionId },
  });

  return processRecord !== null;
}

/**
 * Reconcile all orphaned Claude processes on startup.
 * Should be called once when the server starts.
 */
export async function reconcileOrphanedProcesses(): Promise<{
  total: number;
  reconnected: number;
  cleaned: number;
}> {
  const orphanedProcesses = await prisma.claudeProcess.findMany({
    include: { session: true },
  });

  let reconnected = 0;
  let cleaned = 0;

  for (const processRecord of orphanedProcesses) {
    console.log(`Reconciling orphaned process for session ${processRecord.sessionId}`);

    try {
      const result = await reconnectToClaudeProcess(processRecord.sessionId);
      if (result.reconnected) {
        reconnected++;
        console.log(`Reconnected to running process for session ${processRecord.sessionId}`);
      } else {
        cleaned++;
        console.log(`Cleaned up finished process for session ${processRecord.sessionId}`);
      }
    } catch (err) {
      console.error(`Error reconciling session ${processRecord.sessionId}:`, err);
      // Clean up the record to avoid infinite retry
      await prisma.claudeProcess.delete({ where: { id: processRecord.id } }).catch(() => {});
      cleaned++;
    }
  }

  return {
    total: orphanedProcesses.length,
    reconnected,
    cleaned,
  };
}
