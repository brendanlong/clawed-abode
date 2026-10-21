import { describe, it, expect } from 'vitest';
import { renderHook } from '@testing-library/react';
import { useVoicePlayback } from './useVoicePlayback';

describe('useVoicePlayback', () => {
  // Every message bubble's play button reads this value through context.
  it('returns the same object across re-renders while nothing changed', () => {
    const { result, rerender } = renderHook(({ enabled }) => useVoicePlayback(enabled), {
      initialProps: { enabled: false },
    });
    const first = result.current;
    rerender({ enabled: false });
    expect(result.current).toBe(first);

    rerender({ enabled: true });
    expect(result.current).not.toBe(first);
    expect(result.current.enabled).toBe(true);
  });
});
