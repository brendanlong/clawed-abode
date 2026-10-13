import { afterEach, describe, it, expect, vi } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { useAutoRead } from './useAutoRead';
import type { DisplayMessage } from '@/components/messages/types';

function message(id: string, type: 'user' | 'assistant', text: string): DisplayMessage {
  return {
    id,
    type,
    sequence: 0,
    createdAt: new Date(0),
    content: { message: { content: [{ type: 'text', text }] } },
  };
}

const prompt = message('u1', 'user', 'Go');
const first = message('a1', 'assistant', 'One.');
const followUp = message('u2', 'user', 'Also');
const reply = message('a2', 'assistant', 'Two.');

describe('useAutoRead', () => {
  it('stops playback on send and keeps reading replies to a mid-turn send', () => {
    const enqueue = vi.fn();
    const stop = vi.fn();
    const { result, rerender } = renderHook(
      ({ messages }: { messages: DisplayMessage[] }) =>
        useAutoRead({ enqueue, stop }, { isRunning: true, messages, enabled: true }),
      { initialProps: { messages: [prompt, first] } }
    );
    expect(enqueue).toHaveBeenCalledWith({ messageId: 'a1', text: 'One.' });

    act(() => result.current.onPromptSent());
    expect(stop).toHaveBeenCalledTimes(1);

    rerender({ messages: [prompt, first, followUp, reply] });
    expect(enqueue).toHaveBeenLastCalledWith({ messageId: 'a2', text: 'Two.' });
  });

  it('stops playback and stays quiet for the rest of the turn after a stop', () => {
    const enqueue = vi.fn();
    const stop = vi.fn();
    const { result, rerender } = renderHook(
      ({ messages }: { messages: DisplayMessage[] }) =>
        useAutoRead({ enqueue, stop }, { isRunning: true, messages, enabled: true }),
      { initialProps: { messages: [prompt] } }
    );

    act(() => result.current.stopPlayback());
    expect(stop).toHaveBeenCalledTimes(1);

    rerender({ messages: [prompt, first] });
    expect(enqueue).not.toHaveBeenCalled();
  });

  describe('OS media-control Stop', () => {
    const handlers = new Map<MediaSessionAction, MediaSessionActionHandler | null>();

    function installMediaSession() {
      Object.defineProperty(navigator, 'mediaSession', {
        configurable: true,
        value: {
          setActionHandler: (action: MediaSessionAction, h: MediaSessionActionHandler | null) =>
            handlers.set(action, h),
        },
      });
    }

    afterEach(() => {
      handlers.clear();
      Reflect.deleteProperty(navigator, 'mediaSession');
    });

    it('mutes the rest of the turn like the in-app Stop', () => {
      installMediaSession();
      const enqueue = vi.fn();
      const stop = vi.fn();
      const { rerender } = renderHook(
        ({ messages }: { messages: DisplayMessage[] }) =>
          useAutoRead({ enqueue, stop }, { isRunning: true, messages, enabled: true }),
        { initialProps: { messages: [prompt] } }
      );

      act(() => handlers.get('stop')?.({ action: 'stop' }));
      expect(stop).toHaveBeenCalledTimes(1);

      rerender({ messages: [prompt, first] });
      expect(enqueue).not.toHaveBeenCalled();
    });

    it('hands Stop back to plain playback stop when auto-read turns off', () => {
      installMediaSession();
      const enqueue = vi.fn();
      const stop = vi.fn();
      const { rerender } = renderHook(
        ({ enabled }: { enabled: boolean }) =>
          useAutoRead({ enqueue, stop }, { isRunning: true, messages: [prompt], enabled }),
        { initialProps: { enabled: true } }
      );

      rerender({ enabled: false });
      expect(handlers.get('stop')).toBe(stop);
    });
  });
});
