import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  IDLE_SPEECH_STATE,
  SpeechPlayer,
  type PlayerAudio,
  type RequestSpeechUrl,
  type SpeechPlayerState,
} from './speech-player';

/** Records what the player asks of the element; events are fired by the test. */
class FakeAudio extends EventTarget {
  src = '';
  paused = true;
  playResult: () => Promise<void> = () => Promise.resolve();
  /** Every src play() was called with, including the unlocking silence. */
  readonly played: string[] = [];

  /** The speech URLs played, without the silence. */
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

interface PendingUrl {
  text: string;
  signal: AbortSignal;
  resolve: (url: string) => void;
  reject: (error: Error) => void;
}

let audio: FakeAudio;
let requests: PendingUrl[];
let states: SpeechPlayerState[];
let player: SpeechPlayer;

const latest = () => states[states.length - 1];
const item = (n: number) => ({ messageId: `m${n}`, text: `Message ${n}.` });

/** Let the player's awaits on the URL request and play() settle. */
const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

async function answer(index: number, url: string): Promise<void> {
  requests[index].resolve(url);
  await settle();
}

beforeEach(() => {
  audio = new FakeAudio();
  requests = [];
  states = [];
  const requestUrl: RequestSpeechUrl = (text, signal) =>
    new Promise((resolve, reject) => requests.push({ text, signal, resolve, reject }));
  player = new SpeechPlayer(audio as unknown as PlayerAudio, requestUrl, (s) => states.push(s));
});

describe('SpeechPlayer', () => {
  it('shows loading until the stream starts, then playing', async () => {
    player.play(item(1));
    expect(latest()).toEqual({ ...IDLE_SPEECH_STATE, currentMessageId: 'm1', isLoading: true });
    expect(requests[0].text).toBe('Message 1.');

    await answer(0, '/api/tts/a');
    expect(audio.streams).toEqual(['/api/tts/a']);
    audio.fire('playing');
    expect(latest()).toMatchObject({ currentMessageId: 'm1', isLoading: false, isPlaying: true });
  });

  it('toggles pause and resume when the current message is played again', async () => {
    player.play(item(1));
    await answer(0, '/api/tts/a');
    audio.fire('playing');

    player.play(item(1));
    expect(audio.pause).toHaveBeenCalled();
    audio.fire('pause');
    expect(latest()).toMatchObject({ currentMessageId: 'm1', isPlaying: false });

    player.play(item(1));
    expect(audio.streams).toEqual(['/api/tts/a', '/api/tts/a']);
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

    await answer(0, '/api/tts/stale');
    await answer(1, '/api/tts/b');
    expect(audio.streams).toEqual(['/api/tts/b']);
    expect(latest().currentMessageId).toBe('m2');
  });

  it('plays queued messages in order and goes idle after the last', async () => {
    player.enqueue(item(1));
    player.enqueue(item(2));
    expect(requests).toHaveLength(1);
    await answer(0, '/api/tts/a');

    audio.fire('ended');
    expect(latest()).toMatchObject({ currentMessageId: 'm2', isLoading: true });
    await answer(1, '/api/tts/b');
    audio.fire('ended');

    expect(audio.streams).toEqual(['/api/tts/a', '/api/tts/b']);
    expect(latest()).toEqual(IDLE_SPEECH_STATE);
  });

  it('next() skips to the next queued message', async () => {
    player.enqueue(item(1));
    player.enqueue(item(2));
    await answer(0, '/api/tts/a');
    player.next();
    expect(latest().currentMessageId).toBe('m2');
  });

  it('play() drops the queue', async () => {
    player.enqueue(item(1));
    player.enqueue(item(2));
    player.play(item(3));
    await answer(1, '/api/tts/c');
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

  it('reports a media error', async () => {
    player.play(item(1));
    await answer(0, '/api/tts/a');
    audio.fire('error');
    expect(latest().error).toEqual({ messageId: 'm1', message: 'Audio playback failed' });
  });

  it('stays paused and resumable when autoplay is refused', async () => {
    audio.playResult = () => Promise.reject(new DOMException('no gesture', 'NotAllowedError'));
    player.enqueue(item(1));
    await answer(0, '/api/tts/a');
    expect(latest()).toMatchObject({ currentMessageId: 'm1', isLoading: false, isPlaying: false });
    expect(latest().error).toBeNull();

    audio.playResult = () => Promise.resolve();
    audio.paused = true;
    player.play(item(1));
    expect(audio.streams).toEqual(['/api/tts/a', '/api/tts/a']);
  });

  it('restart() reloads the current stream', async () => {
    player.play(item(1));
    await answer(0, '/api/tts/a');
    audio.src = 'http://localhost/api/tts/a';
    player.restart();
    expect(audio.streams).toEqual(['/api/tts/a', '/api/tts/a']);
  });

  it('play() unlocks the element with silence during the tap, once', async () => {
    player.play(item(1));
    expect(audio.played).toHaveLength(1);
    expect(audio.played[0]).toMatch(/^data:audio\/wav;base64,UklGR/);
    await answer(0, '/api/tts/a');
    player.play(item(2));
    await answer(1, '/api/tts/b');
    expect(audio.played).toHaveLength(3);
  });

  it('prime() resumes a message whose autoplay was refused, and otherwise leaves it alone', async () => {
    audio.playResult = () => Promise.reject(new DOMException('no gesture', 'NotAllowedError'));
    player.enqueue(item(1));
    await answer(0, '/api/tts/a');
    audio.playResult = () => Promise.resolve();

    player.prime();
    expect(audio.streams).toEqual(['/api/tts/a', '/api/tts/a']);
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
    await answer(0, '/api/tts/a');

    finishPrime();
    await settle();
    expect(audio.src).toBe('/api/tts/a');
  });
});
