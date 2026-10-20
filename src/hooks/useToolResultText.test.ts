import { describe, it, expect } from 'vitest';
import { TRPCClientError } from '@trpc/client';
import { shouldRetryToolResult } from './useToolResultText';

function trpcError(code: string) {
  return TRPCClientError.from({ error: { code: -32004, message: code, data: { code } } });
}

describe('shouldRetryToolResult', () => {
  it('never retries a result the server says does not exist', () => {
    expect(shouldRetryToolResult(0, trpcError('NOT_FOUND'))).toBe(false);
  });

  it('retries other failures up to the usual three times', () => {
    const error = trpcError('INTERNAL_SERVER_ERROR');
    expect(shouldRetryToolResult(0, error)).toBe(true);
    expect(shouldRetryToolResult(2, error)).toBe(true);
    expect(shouldRetryToolResult(3, error)).toBe(false);
    expect(shouldRetryToolResult(0, new Error('network down'))).toBe(true);
  });
});
