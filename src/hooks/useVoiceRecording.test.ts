import { renderHook, act } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { useVoiceRecording } from './useVoiceRecording';

interface MockRecognitionEvent {
  resultIndex: number;
  results: Array<{ isFinal: boolean; 0: { transcript: string } }>;
}

interface MockRecognitionErrorEvent {
  error: string;
  message: string;
}

interface MockSpeechRecognition {
  continuous: boolean;
  interimResults: boolean;
  lang: string;
  start: ReturnType<typeof vi.fn>;
  stop: ReturnType<typeof vi.fn>;
  abort: ReturnType<typeof vi.fn>;
  onresult: ((event: MockRecognitionEvent) => void) | null;
  onerror: ((event: MockRecognitionErrorEvent) => void) | null;
  onend: (() => void) | null;
}

function makeMockRecognition(): MockSpeechRecognition {
  return {
    continuous: false,
    interimResults: false,
    lang: '',
    start: vi.fn(),
    stop: vi.fn(),
    abort: vi.fn(),
    onresult: null,
    onerror: null,
    onend: null,
  };
}

// Tests are skipped due to a pre-existing React.act infrastructure issue in the jsdom
// test environment (React 19 + @testing-library/react). See GitHub issue #320.
describe.skip('useVoiceRecording', () => {
  let mockInstance: MockSpeechRecognition;

  beforeEach(() => {
    mockInstance = makeMockRecognition();
    const MockConstructor = vi.fn(() => mockInstance);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (window as any).SpeechRecognition = MockConstructor;
  });

  /**
   * Simulate a SpeechRecognition result event. `resultIndex` matches the Web
   * Speech API spec: it is the index of the first NEW result in the list.
   * Previous results are unchanged from the last event.
   */
  function fireResult(results: Array<{ isFinal: boolean; transcript: string }>, resultIndex = 0) {
    mockInstance.onresult?.({
      resultIndex,
      results: results.map((r) => ({ isFinal: r.isFinal, 0: { transcript: r.transcript } })),
    });
  }

  it('reports finalized text via onFinalizedText callback', () => {
    const onFinalized = vi.fn();
    const { result } = renderHook(() => useVoiceRecording(onFinalized));

    act(() => result.current.startRecording());
    act(() => fireResult([{ isFinal: true, transcript: 'hello ' }], 0));

    expect(onFinalized).toHaveBeenCalledWith('hello ');
  });

  it('does not report interim text as finalized', () => {
    const onFinalized = vi.fn();
    const { result } = renderHook(() => useVoiceRecording(onFinalized));

    act(() => result.current.startRecording());
    act(() => fireResult([{ isFinal: false, transcript: 'hello' }], 0));

    expect(onFinalized).not.toHaveBeenCalled();
    expect(result.current.interimTranscript).toBe('hello');
  });

  it('only reports each result once using resultIndex', () => {
    const onFinalized = vi.fn();
    const { result } = renderHook(() => useVoiceRecording(onFinalized));

    act(() => result.current.startRecording());
    // First word finalized — resultIndex=0, result[0] is new
    act(() => fireResult([{ isFinal: true, transcript: 'hello ' }], 0));
    // Second word finalized — resultIndex=1, only result[1] is new; result[0] already handled
    act(() =>
      fireResult(
        [
          { isFinal: true, transcript: 'hello ' },
          { isFinal: true, transcript: 'world ' },
        ],
        1
      )
    );

    expect(onFinalized).toHaveBeenCalledTimes(2);
    expect(onFinalized).toHaveBeenNthCalledWith(1, 'hello ');
    expect(onFinalized).toHaveBeenNthCalledWith(2, 'world ');
  });

  it('correctly processes new results after silence timeout auto-restart', () => {
    const onFinalized = vi.fn();
    const { result } = renderHook(() => useVoiceRecording(onFinalized));

    act(() => result.current.startRecording());

    // First session: "hello " is finalized
    act(() => fireResult([{ isFinal: true, transcript: 'hello ' }], 0));
    expect(onFinalized).toHaveBeenCalledWith('hello ');
    onFinalized.mockClear();

    // Browser fires onend (silence timeout), hook auto-restarts
    act(() => mockInstance.onend?.());
    expect(mockInstance.start).toHaveBeenCalledTimes(2); // initial + restart

    // Second session starts fresh — results list resets to index 0
    act(() => fireResult([{ isFinal: true, transcript: 'world ' }], 0));

    // "world " should be reported correctly, not skipped or garbled
    expect(onFinalized).toHaveBeenCalledWith('world ');
  });

  it('clears interim transcript on auto-restart', () => {
    const { result } = renderHook(() => useVoiceRecording());

    act(() => result.current.startRecording());
    // Interim result before silence timeout
    act(() => fireResult([{ isFinal: false, transcript: 'partial' }], 0));
    expect(result.current.interimTranscript).toBe('partial');

    // Auto-restart on silence timeout
    act(() => mockInstance.onend?.());

    // Stale interim should be cleared
    expect(result.current.interimTranscript).toBe('');
  });

  it('returns remaining interim text when stopRecording is called', () => {
    const { result } = renderHook(() => useVoiceRecording());

    act(() => result.current.startRecording());
    act(() => fireResult([{ isFinal: false, transcript: 'hey there' }], 0));

    let remaining: string | undefined;
    act(() => {
      remaining = result.current.stopRecording();
    });

    expect(remaining).toBe('hey there');
  });

  it('does not auto-restart after intentional stopRecording', () => {
    const { result } = renderHook(() => useVoiceRecording());

    act(() => result.current.startRecording());
    act(() => result.current.stopRecording());

    // onend fires after stop() — should NOT restart
    act(() => mockInstance.onend?.());

    expect(mockInstance.start).toHaveBeenCalledTimes(1); // only the initial start
  });

  it('reports a user-friendly error for microphone permission denial', () => {
    const { result } = renderHook(() => useVoiceRecording());

    act(() => result.current.startRecording());
    act(() => mockInstance.onerror?.({ error: 'not-allowed', message: '' }));

    expect(result.current.error).toBe(
      'Microphone permission denied. Please allow microphone access.'
    );
  });

  it('ignores no-speech and aborted errors', () => {
    const { result } = renderHook(() => useVoiceRecording());

    act(() => result.current.startRecording());
    act(() => mockInstance.onerror?.({ error: 'no-speech', message: '' }));
    act(() => mockInstance.onerror?.({ error: 'aborted', message: '' }));

    expect(result.current.error).toBeNull();
  });

  it('marks stopped and does not restart when start() throws in onend', () => {
    const { result } = renderHook(() => useVoiceRecording());

    act(() => result.current.startRecording());
    mockInstance.start.mockImplementationOnce(() => {
      throw new Error('cannot restart');
    });
    act(() => mockInstance.onend?.());

    expect(result.current.isRecording).toBe(false);
  });

  it('stops recognition on unmount', () => {
    const { result, unmount } = renderHook(() => useVoiceRecording());

    act(() => result.current.startRecording());
    unmount();

    expect(mockInstance.stop).toHaveBeenCalled();
  });
});
