import { describe, it, expect } from 'vitest';
import { resolveListQueryState } from './list-query-state';

describe('resolveListQueryState', () => {
  it('reports loading before anything else', () => {
    expect(resolveListQueryState({ isLoading: true, hasError: true, itemCount: 0 })).toBe(
      'loading'
    );
  });

  it('distinguishes a failed query from a genuinely empty one', () => {
    expect(resolveListQueryState({ isLoading: false, hasError: true, itemCount: 0 })).toBe('error');
    expect(resolveListQueryState({ isLoading: false, hasError: false, itemCount: 0 })).toBe(
      'empty'
    );
  });

  it('keeps showing stale data when a refetch fails', () => {
    expect(resolveListQueryState({ isLoading: false, hasError: true, itemCount: 3 })).toBe('ready');
  });

  it('is ready when data loaded successfully', () => {
    expect(resolveListQueryState({ isLoading: false, hasError: false, itemCount: 3 })).toBe(
      'ready'
    );
  });
});
