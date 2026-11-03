import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  IDLE_SPEECH_STATE,
  SpeechPlayer,
  UNSUPPORTED_MESSAGE,
  type AttachMediaSource,
  type OpenSpeech,
  type PlayerAudio,
  type SpeechPlayerState,
} from './speech-player';

/** Records what the player asks of the element; events are fired by the test. */
class FakeAudio extends EventTarget {
  src = '';
  paused = true;
  disableRemotePlayback = false;
  playResult: () => Promise<void> = () => Promise.resolve();
  /** Every src play() was called with, including the unlocking silence. */
  readonly played: string[] = [];

  /** The media sources played, without the silence. */
  get streams(): string[] {
    return this.played.filter((src) => !src.startsWith('data:'));
  }

  play = vi.fn(() => {
    this.played.push(this.src);
    this.paused = false;
    return this.playResult();
  });
  pause = vi.fn(() => {
    this.paused = true;
  });
  load = vi.fn();
  removeAttribute = vi.fn((name: string) => {
    if (name === 'src') this.src = '';
  });

  fire(event: string): void {
    this.dispatchEvent(new Event(event));
  }
}

class FakeSourceBuffer extends EventTarget {
  mode = 'segments';
  readonly appended: number[][] = [];
  failNext = false;

  appendBuffer(bytes: Uint8Array): void {
    this.appended.push([...bytes]);
    const event = this.failNext ? 'error' : 'updateend';
    setTimeout(() => this.dispatchEvent(new Event(event)), 0);
  }
}

class FakeMediaSource extends EventTarget {
  readyState: ReadyState = 'closed';
  buffer: FakeSourceBuffer | null = null;
  mimeType: string | null = null;
  released = false;

  constructor(readonly url: string) {
    super();
  }

  open(): void {
    this.readyState = 'open';
    this.dispatchEvent(new Event('sourceopen'));
  }

  addSourceBuffer(mimeType: string): FakeSourceBuffer {
    this.mimeType = mimeType;
    this.buffer = new FakeSourceBuffer();
    return this.buffer;
  }

  endOfStream = vi.fn(() => {
    this.readyState = 'ended';
  });
}

/** Speech pieces the test sends, as one message's encoder would produce them. */
class PendingSpeech {
  private readonly queued: Uint8Array[] = [];
  private ended = false;
  private error: Error | null = null;
  private wake: (() => void) | null = null;

  constructor(
    readonly text: string,
    readonly signal: AbortSignal,
    readonly resolve: () => void,
    readonly reject: (error: Error) => void
  ) {}

  send(...values: number[]): void {
    this.queued.push(new Uint8Array(values));
    this.wake?.();
  }

  end(): void {
    this.ended = true;
    this.wake?.();
  }

  fail(error: Error): void {
    this.error = error;
    this.wake?.();
  }

  async *pieces(): AsyncGenerator<Uint8Array> {
    for (;;) {
      const piece = this.queued.shift();
      if (piece) yield piece;
      else if (this.error) throw this.error;
      else if (this.ended) return;
      else await new Promise<void>((resolve) => (this.wake = resolve));
    }
  }
}

let audio: FakeAudio;
let requests: PendingSpeech[];
let sources: FakeMediaSource[];
let states: SpeechPlayerState[];
let player: SpeechPlayer;

const latest = () => states[states.length - 1];
const item = (n: number) => ({ messageId: `m${n}`, text: `Message ${n}.` });

/** Let the player's awaits on the request, the source, and play() settle. */
const settle = () => new Promise((resolve) => setTimeout(resolve, 5));

/** Answer request `index`, open its media source, and return that source. */
async function answer(index: number): Promise<FakeMediaSource> {
  requests[index].resolve();
  await settle();
  const source = sources[sources.length - 1];
  source.open();
  await settle();
  return source;
}

beforeEach(() => {
  audio = new FakeAudio();
  requests = [];
  sources = [];
  states = [];
  const openSpeech: OpenSpeech = (text, signal) =>
    new Promise((resolve, reject) => {
      const speech: PendingSpeech = new PendingSpeech(
        text,
        signal,
        () => resolve({ mimeType: 'audio/mp4; codecs="mp4a.40.2"', pieces: speech.pieces() }),
        reject
      );
      requests.push(speech);
    });
  const attach: AttachMediaSource = (element) => {
    const source = new FakeMediaSource(`blob:speech-${sources.length}`);
    sources.push(source);
    element.src = source.url;
    return {
      source: source as unknown as MediaSource,
      release: () => (source.released = true),
    };
  };
  player = new SpeechPlayer(
    audio as unknown as PlayerAudio,
    openSpeech,
    (s) => states.push(s),
    attach
  );
});

describe('SpeechPlayer', () => {
  it('shows loading until the stream starts, then playing', async () => {
    player.play(item(1));
    expect(latest()).toEqual({ ...IDLE_SPEECH_STATE, currentMessageId: 'm1', isLoading: true });
    expect(requests[0].text).toBe('Message 1.');

    await answer(0);
    expect(audio.streams).toEqual(['blob:speech-0']);
    audio.fire('playing');
    expect(latest()).toMatchObject({ currentMessageId: 'm1', isLoading: false, isPlaying: true });
  });

  it('appends the speech in sequence mode as it arrives, then ends the stream', async () => {
    player.play(item(1));
    const source = await answer(0);
    expect(source.mimeType).toBe('audio/mp4; codecs="mp4a.40.2"');
    expect(source.buffer?.mode).toBe('sequence');

    requests[0].send(1, 2);
    await settle();
    expect(source.buffer?.appended).toEqual([[1, 2]]);
    expect(source.endOfStream).not.toHaveBeenCalled();

    requests[0].send(3);
    requests[0].end();
    await settle();
    expect(source.buffer?.appended).toEqual([[1, 2], [3]]);
    expect(source.endOfStream).toHaveBeenCalled();
  });

  it('toggles pause and resume when the current message is played again', async () => {
    player.play(item(1));
    await answer(0);
    audio.fire('playing');

    player.play(item(1));
    expect(audio.pause).toHaveBeenCalled();
    audio.fire('pause');
    expect(latest()).toMatchObject({ currentMessageId: 'm1', isPlaying: false });

    player.play(item(1));
    expect(audio.streams).toEqual(['blob:speech-0', 'blob:speech-0']);
    expect(requests).toHaveLength(1);
  });

  it('cancels a pending request when the same message is tapped while loading', () => {
    player.play(item(1));
    player.play(item(1));
    expect(requests[0].signal.aborted).toBe(true);
    expect(latest()).toEqual(IDLE_SPEECH_STATE);
  });

  it('switching messages abandons the pending one', async () => {
    player.play(item(1));
    player.play(item(2));
    expect(requests[0].signal.aborted).toBe(true);

    requests[0].resolve();
    await settle();
    expect(sources).toHaveLength(0);
    await answer(1);
    expect(audio.streams).toEqual(['blob:speech-0']);
    expect(latest().currentMessageId).toBe('m2');
  });

  it('switching messages stops buffering the old one and releases its source', async () => {
    player.play(item(1));
    const first = await answer(0);
    player.play(item(2));
    expect(requests[0].signal.aborted).toBe(true);
    expect(first.released).toBe(true);

    requests[0].send(1);
    await settle();
    expect(first.buffer?.appended).toEqual([]);
  });

  it('plays queued messages in order and goes idle after the last', async () => {
    player.enqueue(item(1));
    player.enqueue(item(2));
    expect(requests).toHaveLength(1);
    await answer(0);

    audio.fire('ended');
    expect(latest()).toMatchObject({ currentMessageId: 'm2', isLoading: true });
    await answer(1);
    audio.fire('ended');

    expect(audio.streams).toEqual(['blob:speech-0', 'blob:speech-1']);
    expect(latest()).toEqual(IDLE_SPEECH_STATE);
  });

  it('moves on from a message with no audio at all', async () => {
    player.enqueue(item(1));
    player.enqueue(item(2));
    await answer(0);
    requests[0].end();
    await settle();
    expect(latest()).toMatchObject({ currentMessageId: 'm2', isLoading: true });
  });

  it('next() skips to the next queued message', async () => {
    player.enqueue(item(1));
    player.enqueue(item(2));
    await answer(0);
    player.next();
    expect(latest().currentMessageId).toBe('m2');
  });

  it('play() drops the queue', async () => {
    player.enqueue(item(1));
    player.enqueue(item(2));
    player.play(item(3));
    await answer(1);
    audio.fire('ended');
    expect(requests.map((r) => r.text)).toEqual(['Message 1.', 'Message 3.']);
    expect(latest()).toEqual(IDLE_SPEECH_STATE);
  });

  it('reports a failed request against its message and drops the queue', async () => {
    player.enqueue(item(1));
    player.enqueue(item(2));
    requests[0].reject(new Error('TTS provider returned 401'));
    await settle();

    expect(latest()).toEqual({
      ...IDLE_SPEECH_STATE,
      error: { messageId: 'm1', message: 'TTS provider returned 401' },
    });
    expect(requests).toHaveLength(1);

    player.play(item(1));
    expect(latest().error).toBeNull();
  });

  it('reports speech that fails partway', async () => {
    player.play(item(1));
    await answer(0);
    requests[0].send(1);
    requests[0].fail(new Error('network error'));
    await settle();
    expect(latest().error).toEqual({ messageId: 'm1', message: 'network error' });
  });

  it('reports audio the source buffer refuses', async () => {
    player.play(item(1));
    const source = await answer(0);
    source.buffer!.failNext = true;
    requests[0].send(1);
    await settle();
    expect(latest().error).toEqual({ messageId: 'm1', message: 'Failed to buffer speech audio' });
  });

  it('reports a media error', async () => {
    player.play(item(1));
    await answer(0);
    audio.fire('error');
    expect(latest().error).toEqual({ messageId: 'm1', message: 'Audio playback failed' });
  });

  it('reports a browser without Media Source Extensions', async () => {
    player = new SpeechPlayer(
      audio as unknown as PlayerAudio,
      async () => ({ mimeType: 'audio/mp4', pieces: (async function* () {})() }),
      (s) => states.push(s),
      () => null
    );
    player.play(item(1));
    await settle();
    expect(latest().error).toEqual({ messageId: 'm1', message: UNSUPPORTED_MESSAGE });
  });

  it('stays paused and resumable when autoplay is refused', async () => {
    audio.playResult = () => Promise.reject(new DOMException('no gesture', 'NotAllowedError'));
    player.enqueue(item(1));
    await answer(0);
    expect(latest()).toMatchObject({ currentMessageId: 'm1', isLoading: false, isPlaying: false });
    expect(latest().error).toBeNull();

    audio.playResult = () => Promise.resolve();
    audio.paused = true;
    player.play(item(1));
    expect(audio.streams).toEqual(['blob:speech-0', 'blob:speech-0']);
  });

  it('restart() plays the current message again from the start', async () => {
    player.play(item(1));
    await answer(0);
    player.restart();
    expect(requests).toHaveLength(2);
    expect(requests[0].signal.aborted).toBe(true);
    expect(requests[1].text).toBe('Message 1.');
    await answer(1);
    expect(audio.streams).toEqual(['blob:speech-0', 'blob:speech-1']);
  });

  it('play() unlocks the element with silence during the tap, once', async () => {
    player.play(item(1));
    expect(audio.played).toHaveLength(1);
    expect(audio.played[0]).toMatch(/^data:audio\/wav;base64,UklGR/);
    await answer(0);
    player.play(item(2));
    await answer(1);
    expect(audio.played).toHaveLength(3);
  });

  it('prime() resumes a message whose autoplay was refused, and otherwise leaves it alone', async () => {
    audio.playResult = () => Promise.reject(new DOMException('no gesture', 'NotAllowedError'));
    player.enqueue(item(1));
    await answer(0);
    audio.playResult = () => Promise.resolve();

    player.prime();
    expect(audio.streams).toEqual(['blob:speech-0', 'blob:speech-0']);
    player.prime();
    expect(audio.played).toHaveLength(2);
  });

  it('prime() plays silence once, ignores its events, and clears it afterwards', async () => {
    player.prime();
    player.prime();
    expect(audio.played).toHaveLength(1);
    expect(audio.played[0]).toMatch(/^data:audio\/wav;base64,UklGR/);
    audio.fire('playing');
    audio.fire('ended');
    await settle();
    expect(audio.src).toBe('');
    expect(states).toEqual([]);
  });

  it('silence that is still starting leaves a message that started meanwhile alone', async () => {
    let finishPrime: () => void = () => {};
    audio.playResult = () => new Promise((resolve) => (finishPrime = resolve));
    player.prime();
    audio.playResult = () => Promise.resolve();
    player.play(item(1));
    await answer(0);

    finishPrime();
    await settle();
    expect(audio.src).toBe('blob:speech-0');
  });
});
