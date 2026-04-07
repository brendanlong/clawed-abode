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
    act(() => fireResult([{ isFinal: true, transcript: 'hello ' }]));

    expect(onFinalized).toHaveBeenCalledWith('hello ');
  });

  it('does not report interim text as finalized', () => {
    const onFinalized = vi.fn();
    const { result } = renderHook(() => useVoiceRecording(onFinalized));

    act(() => result.current.startRecording());
    act(() => fireResult([{ isFinal: false, transcript: 'hello' }]));

    expect(onFinalized).not.toHaveBeenCalled();
    expect(result.current.interimTranscript).toBe('hello');
  });

  it('only reports delta (not full text) when new finals arrive', () => {
    const onFinalized = vi.fn();
    const { result } = renderHook(() => useVoiceRecording(onFinalized));

    act(() => result.current.startRecording());
    // First word finalized
    act(() => fireResult([{ isFinal: true, transcript: 'hello ' }]));
    // Second word finalized — cumulative results list
    act(() =>
      fireResult([
        { isFinal: true, transcript: 'hello ' },
        { isFinal: true, transcript: 'world ' },
      ])
    );

    expect(onFinalized).toHaveBeenCalledTimes(2);
    expect(onFinalized).toHaveBeenNthCalledWith(1, 'hello ');
    expect(onFinalized).toHaveBeenNthCalledWith(2, 'world ');
  });

  it('resets the finalized offset when auto-restarting after silence timeout', () => {
    const onFinalized = vi.fn();
    const { result } = renderHook(() => useVoiceRecording(onFinalized));

    act(() => result.current.startRecording());

    // First session: "hello " is finalized
    act(() => fireResult([{ isFinal: true, transcript: 'hello ' }]));
    expect(onFinalized).toHaveBeenCalledWith('hello ');
    onFinalized.mockClear();

    // Browser fires onend (silence timeout), hook auto-restarts
    act(() => mockInstance.onend?.());
    expect(mockInstance.start).toHaveBeenCalledTimes(2); // initial + restart

    // Second session starts fresh — results list resets to index 0
    act(() => fireResult([{ isFinal: true, transcript: 'world ' }]));

    // "world " should be reported, not skipped or garbled
    expect(onFinalized).toHaveBeenCalledWith('world ');
  });

  it('returns remaining interim text when stopRecording is called', () => {
    const { result } = renderHook(() => useVoiceRecording());

    act(() => result.current.startRecording());
    act(() => fireResult([{ isFinal: false, transcript: 'hey there' }]));

    let remaining: string | undefined;
    act(() => {
      remaining = result.current.stopRecording();
    });

    expect(remaining).toBe('hey there');
  });
});
