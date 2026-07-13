import { describe, it, expect } from 'vitest';
import { deriveSessionDisplayStatus } from './session-display-status';

describe('deriveSessionDisplayStatus', () => {
  it('shows "running" for a live session with an active turn', () => {
    expect(deriveSessionDisplayStatus('running', true)).toBe('running');
  });

  it('shows "running" when both the main agent and a background task are active', () => {
    expect(deriveSessionDisplayStatus('running', true, true)).toBe('running');
  });

  it('shows "background" when the main agent is idle but a background task runs', () => {
    expect(deriveSessionDisplayStatus('running', false, true)).toBe('background');
  });

  it('shows "waiting" for a live session that is fully idle', () => {
    expect(deriveSessionDisplayStatus('running', false)).toBe('waiting');
    expect(deriveSessionDisplayStatus('running', false, false)).toBe('waiting');
  });

  it.each(['stopped', 'creating', 'error', 'archived'])(
    'passes through %s regardless of turnActive/backgroundActive',
    (status) => {
      expect(deriveSessionDisplayStatus(status, false)).toBe(status);
      // turnActive/backgroundActive can never be true without a live query, but the
      // derivation must not invent a live label for a non-running session either way.
      expect(deriveSessionDisplayStatus(status, true)).toBe(status);
      expect(deriveSessionDisplayStatus(status, false, true)).toBe(status);
      expect(deriveSessionDisplayStatus(status, true, true)).toBe(status);
    }
  );
});
