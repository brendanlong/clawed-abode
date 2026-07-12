import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { useVoiceRecording } from './useVoiceRecording';

// Minimal fake of the Web Speech API's SpeechRecognition, letting tests drive
// onresult/onend directly.
type FakeResult = { transcript: string; isFinal: boolean };

class FakeSpeechRecognition extends EventTarget {
  static instances: FakeSpeechRecognition[] = [];
  continuous = false;
  interimResults = false;
  lang = '';
  started = false;
  onresult: ((event: unknown) => void) | null = null;
  onerror: ((event: unknown) => void) | null = null;
  onend: (() => void) | null = null;

  constructor() {
    super();
    FakeSpeechRecognition.instances.push(this);
  }

  start() {
    this.started = true;
  }

  stop() {
    this.started = false;
  }

  abort() {
    this.started = false;
  }

  emitResults(results: FakeResult[]) {
    this.onresult?.({
      resultIndex: 0,
      results: results.map((r) => ({
        isFinal: r.isFinal,
        0: { transcript: r.transcript },
        length: 1,
      })),
    });
  }
}

describe('useVoiceRecording', () => {
  beforeEach(() => {
    FakeSpeechRecognition.instances = [];
    (window as unknown as Record<string, unknown>).SpeechRecognition = FakeSpeechRecognition;
  });

  afterEach(() => {
    delete (window as unknown as Record<string, unknown>).SpeechRecognition;
    vi.restoreAllMocks();
  });

  function record() {
    const hook = renderHook(() => useVoiceRecording());
    act(() => hook.result.current.startRecording());
    const recognition = FakeSpeechRecognition.instances.at(-1)!;
    return { hook, recognition };
  }

  it('exposes interim then finalized text as the user speaks', () => {
    const { hook, recognition } = record();

    act(() => recognition.emitResults([{ transcript: 'hello', isFinal: false }]));
    expect(hook.result.current.interimTranscript).toBe('hello');

    act(() =>
      recognition.emitResults([
        { transcript: 'hello world', isFinal: true },
        { transcript: ' how are', isFinal: false },
      ])
    );
    expect(hook.result.current.interimTranscript).toBe('hello world how are');
  });

  it('does not garble the transcript when the browser revises an earlier final result', () => {
    const { hook, recognition } = record();

    act(() => recognition.emitResults([{ transcript: 'hello', isFinal: true }]));
    // The browser revises the already-final result ("hello" -> "yellow"). The
    // old length-delta accumulation appended the substring past the previous
    // length ("w"), producing garbled text like "hellow".
    act(() => recognition.emitResults([{ transcript: 'yellow', isFinal: true }]));

    expect(hook.result.current.interimTranscript).toBe('yellow');
  });

  it('does not repeat words when the browser re-delivers cumulative results (Android)', () => {
    const { hook, recognition } = record();

    act(() => recognition.emitResults([{ transcript: 'one two', isFinal: true }]));
    // Android Chrome re-delivers the full utterance so far as the results list
    // grows; rebuilding from event.results must not duplicate "one two".
    act(() => recognition.emitResults([{ transcript: 'one two three', isFinal: true }]));
    act(() => recognition.emitResults([{ transcript: 'one two three', isFinal: true }]));

    expect(hook.result.current.interimTranscript).toBe('one two three');
  });

  it('preserves text across an auto-restart and keeps new sessions separate', () => {
    const { hook, recognition } = record();

    act(() =>
      recognition.emitResults([
        { transcript: 'first part', isFinal: true },
        { transcript: ' trailing', isFinal: false },
      ])
    );

    // Browser ends the session unexpectedly; the hook auto-restarts.
    act(() => recognition.onend?.());
    expect(recognition.started).toBe(true);

    // The new session's results start fresh and must not clobber or duplicate
    // the previous session's text (including the unfinalized interim residual).
    act(() => recognition.emitResults([{ transcript: ' second part', isFinal: true }]));
    expect(hook.result.current.interimTranscript).toBe('first part trailing second part');
  });

  it('returns the full transcript from stopRecording and resets state', () => {
    const { hook, recognition } = record();

    act(() => recognition.emitResults([{ transcript: 'send it', isFinal: true }]));
    act(() =>
      recognition.emitResults([
        { transcript: 'send it', isFinal: true },
        { transcript: ' now', isFinal: false },
      ])
    );

    let transcript = '';
    act(() => {
      transcript = hook.result.current.stopRecording();
    });

    expect(transcript).toBe('send it now');
    expect(hook.result.current.isRecording).toBe(false);
    expect(hook.result.current.interimTranscript).toBe('');
    // stop() cleared the ref, so onend must not restart
    act(() => recognition.onend?.());
    expect(recognition.started).toBe(false);
  });
});
