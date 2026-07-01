import { describe, it, expect } from 'vitest';
import { deriveSessionDisplayStatus } from './session-display-status';

describe('deriveSessionDisplayStatus', () => {
  it('shows "running" for a live session with an active turn', () => {
    expect(deriveSessionDisplayStatus('running', true)).toBe('running');
  });

  it('shows "waiting" for a live session with no active turn', () => {
    expect(deriveSessionDisplayStatus('running', false)).toBe('waiting');
  });

  it.each(['stopped', 'creating', 'error', 'archived'])(
    'passes through %s regardless of turnActive',
    (status) => {
      expect(deriveSessionDisplayStatus(status, false)).toBe(status);
      // turnActive can never be true without a live query, but the derivation
      // must not invent a "running" label for a non-running session either way.
      expect(deriveSessionDisplayStatus(status, true)).toBe(status);
    }
  );
});
