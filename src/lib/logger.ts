/**
 * Centralized logging utility for the server.
 * Provides consistent, structured logging across all backend services.
 */

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

interface LogEntry {
  timestamp: string;
  level: LogLevel;
  context: string;
  message: string;
  data?: Record<string, unknown>;
  error?: {
    name: string;
    message: string;
    stack?: string;
  };
}

function formatLogEntry(entry: LogEntry): string {
  const { timestamp, level, context, message, data, error } = entry;
  const levelUpper = level.toUpperCase().padEnd(5);
  let output = `[${timestamp}] [${levelUpper}] [${context}] ${message}`;

  if (data && Object.keys(data).length > 0) {
    output += ` ${JSON.stringify(data)}`;
  }

  if (error) {
    output += `\n  Error: ${error.name}: ${error.message}`;
    if (error.stack) {
      // Indent stack trace for readability
      const stackLines = error.stack.split('\n').slice(1); // Skip first line (redundant with message)
      if (stackLines.length > 0) {
        output += '\n  ' + stackLines.join('\n  ');
      }
    }
  }

  return output;
}

function createLogEntry(
  level: LogLevel,
  context: string,
  message: string,
  data?: Record<string, unknown>,
  error?: Error
): LogEntry {
  const entry: LogEntry = {
    timestamp: new Date().toISOString(),
    level,
    context,
    message,
  };

  if (data && Object.keys(data).length > 0) {
    entry.data = data;
  }

  if (error) {
    entry.error = {
      name: error.name,
      message: error.message,
      stack: error.stack,
    };
  }

  return entry;
}

function writeLog(entry: LogEntry): void {
  const formatted = formatLogEntry(entry);

  if (entry.level === 'error') {
    console.error(formatted);
  } else if (entry.level === 'warn') {
    console.warn(formatted);
  } else {
    console.log(formatted);
  }
}

/**
 * Creates a logger instance for a specific context (e.g., service name).
 */
export function createLogger(context: string) {
  return {
    debug(message: string, data?: Record<string, unknown>): void {
      writeLog(createLogEntry('debug', context, message, data));
    },

    info(message: string, data?: Record<string, unknown>): void {
      writeLog(createLogEntry('info', context, message, data));
    },

    warn(message: string, data?: Record<string, unknown>, error?: Error): void {
      writeLog(createLogEntry('warn', context, message, data, error));
    },

    error(message: string, error?: Error, data?: Record<string, unknown>): void {
      writeLog(createLogEntry('error', context, message, data, error));
    },
  };
}

/**
 * Extracts a useful error message from an unknown error value.
 */
export function getErrorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }
  if (typeof error === 'string') {
    return error;
  }
  return 'Unknown error';
}

/**
 * Ensures the error is an Error instance for logging.
 */
export function toError(error: unknown): Error {
  if (error instanceof Error) {
    return error;
  }
  if (typeof error === 'string') {
    return new Error(error);
  }
  return new Error(String(error));
}
