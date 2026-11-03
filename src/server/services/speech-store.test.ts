import { describe, it, expect, vi } from 'vitest';
import type { KokoroVoice } from '@/lib/kokoro-voices';
import { SpeechStore, type Speech, type SynthesizeChunk } from './speech-store';

/** One request's response body, fed by the test. */
class PendingCall {
  private readonly pieces: Uint8Array[] = [];
  private ended = false;
  private error: Error | null = null;
  private wake: (() => void) | null = null;

  constructor(readonly text: string) {}

  send(...values: number[]): void {
    this.pieces.push(new Uint8Array(values));
    this.wake?.();
  }

  /** Send `values` and end the response. */
  resolve(...values: number[]): void {
    if (values.length > 0) this.send(...values);
    this.ended = true;
    this.wake?.();
  }

  reject(error: Error): void {
    this.error = error;
    this.wake?.();
  }

  async *body(): AsyncGenerator<Uint8Array> {
    for (;;) {
      const piece = this.pieces.shift();
      if (piece) yield piece;
      else if (this.error) throw this.error;
      else if (this.ended) return;
      else await new Promise<void>((resolve) => (this.wake = resolve));
    }
  }
}

/** A synthesizer whose responses stay open until the test settles them. */
function controllableSynth() {
  const calls: PendingCall[] = [];
  const synthesize = vi.fn<SynthesizeChunk>((text) => {
    const call = new PendingCall(text);
    calls.push(call);
    return call.body();
  });
  return { calls, synthesize };
}

function makeStore(
  synthesize: SynthesizeChunk,
  overrides: { maxBytes?: number; maxInFlight?: number; now?: () => number } = {}
) {
  return new SpeechStore({
    synthesize,
    maxBytes: 1_000_000,
    ttlMs: 60_000,
    maxInFlight: 4,
    ...overrides,
  });
}

const voice: KokoroVoice = 'af_heart';

async function readAll(speech: Speech): Promise<number[]> {
  const out: number[] = [];
  const reader = speech.stream().getReader();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) return out;
    out.push(...value);
  }
}

const twoChunkText = 'First sentence. Second one.';

describe('SpeechStore', () => {
  it('runs one request at a time when maxInFlight is 1', async () => {
    const { calls, synthesize } = controllableSynth();
    const speech = makeStore(synthesize, { maxInFlight: 1 }).open({
      text: 'One. Two. Three.',
      voice,
      speed: 1,
    });
    const all = readAll(speech);

    await vi.waitFor(() => expect(calls).toHaveLength(1));
    calls[0].resolve(1, 1);
    await vi.waitFor(() => expect(calls).toHaveLength(2));
    calls[1].resolve(2, 2);
    await vi.waitFor(() => expect(calls).toHaveLength(3));
    calls[2].resolve(3, 3);
    expect(await all).toEqual([1, 1, 2, 2, 3, 3]);
  });

  it('synthesizes each sentence with the voice and speed', async () => {
    const { calls, synthesize } = controllableSynth();
    makeStore(synthesize).open({ text: twoChunkText, voice, speed: 1.5 });

    await vi.waitFor(() => expect(calls).toHaveLength(2));
    expect(synthesize).toHaveBeenNthCalledWith(1, 'First sentence.', voice, 1.5);
    expect(synthesize).toHaveBeenNthCalledWith(2, 'Second one.', voice, 1.5);
  });

  it('keeps four requests in flight, starting another as the oldest finishes', async () => {
    const { calls, synthesize } = controllableSynth();
    const text = 'One. Two. Three. Four. Five. Six.';
    const speech = makeStore(synthesize).open({ text, voice, speed: 1 });
    const all = readAll(speech);

    await vi.waitFor(() => expect(calls).toHaveLength(4));
    calls[1].resolve(1, 1);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(calls).toHaveLength(4);

    calls[0].resolve(0, 0);
    await vi.waitFor(() => expect(calls).toHaveLength(6));
    calls.slice(2).forEach((call, i) => call.resolve(i + 2, i + 2));
    expect(await all).toEqual([0, 0, 1, 1, 2, 2, 3, 3, 4, 4, 5, 5]);
  });

  it('streams chunks in order as they arrive, even when they finish out of order', async () => {
    const { calls, synthesize } = controllableSynth();
    const speech = makeStore(synthesize).open({ text: twoChunkText, voice, speed: 1 });
    const all = readAll(speech);

    await vi.waitFor(() => expect(calls).toHaveLength(2));
    calls[1].resolve(3, 4);
    calls[0].resolve(1, 2);

    expect(await all).toEqual([1, 2, 3, 4]);
  });

  it('passes on the playing request’s audio before its response ends', async () => {
    const { calls, synthesize } = controllableSynth();
    const speech = makeStore(synthesize).open({ text: 'Hi.', voice, speed: 1 });
    await vi.waitFor(() => expect(calls).toHaveLength(1));
    calls[0].send(1, 2);
    await speech.ready();
    expect(speech.running).toBe(true);
    expect(speech.bytes).toBe(2);
  });

  it('joins chunks on sample boundaries when network reads split samples', async () => {
    const { calls, synthesize } = controllableSynth();
    const speech = makeStore(synthesize).open({ text: twoChunkText, voice, speed: 1 });
    const all = readAll(speech);

    await vi.waitFor(() => expect(calls).toHaveLength(2));
    calls[0].send(1);
    calls[0].send(2, 3);
    // An odd chunk's stray last byte is dropped rather than shifting every later sample.
    calls[0].resolve(4, 9);
    calls[1].resolve(5, 6);
    expect(await all).toEqual([1, 2, 3, 4, 5, 6]);
  });

  it('replays buffered audio to a late reader and then follows along', async () => {
    const { calls, synthesize } = controllableSynth();
    const speech = makeStore(synthesize).open({ text: twoChunkText, voice, speed: 1 });
    await vi.waitFor(() => expect(calls).toHaveLength(2));
    calls[0].resolve(1, 1);
    await speech.ready();

    const late = readAll(speech);
    calls[1].resolve(2, 2);
    expect(await late).toEqual([1, 1, 2, 2]);
  });

  it('shares one synthesis between identical requests', async () => {
    const { synthesize } = controllableSynth();
    const store = makeStore(synthesize);
    const first = store.open({ text: 'Hi.', voice, speed: 1 });
    const again = store.open({ text: 'Hi.', voice, speed: 1 });
    const faster = store.open({ text: 'Hi.', voice, speed: 2 });

    expect(again).toBe(first);
    expect(faster).not.toBe(first);
    expect(synthesize).toHaveBeenCalledTimes(2);
  });

  it('rejects ready() when the first chunk fails, and retries on the next open', async () => {
    const { calls, synthesize } = controllableSynth();
    const store = makeStore(synthesize);
    const speech = store.open({ text: 'Hi.', voice, speed: 1 });
    await vi.waitFor(() => expect(calls).toHaveLength(1));
    calls[0].reject(new Error('provider returned 401'));

    await expect(speech.ready()).rejects.toThrow('401');
    expect(speech.failed).toBe(true);
    expect(store.open({ text: 'Hi.', voice, speed: 1 })).not.toBe(speech);
    expect(synthesize).toHaveBeenCalledTimes(2);
  });

  it('ends the stream with an error when a later chunk fails', async () => {
    const { calls, synthesize } = controllableSynth();
    const speech = makeStore(synthesize).open({ text: twoChunkText, voice, speed: 1 });
    await vi.waitFor(() => expect(calls).toHaveLength(2));
    calls[0].resolve(1, 1);
    calls[1].reject(new Error('timeout'));

    await expect(readAll(speech)).rejects.toThrow('timeout');
    await expect(speech.ready()).resolves.toBeUndefined();
  });

  it('expires audio unused for the TTL, but never a synthesis still running', async () => {
    let now = 0;
    const { calls, synthesize } = controllableSynth();
    const store = makeStore(synthesize, { now: () => now });
    const running = store.open({ text: 'Running.', voice, speed: 1 });
    const done = store.open({ text: 'Done.', voice, speed: 1 });
    await vi.waitFor(() => expect(calls).toHaveLength(2));
    calls[1].resolve(1, 1);
    await vi.waitFor(() => expect(done.running).toBe(false));

    now = 60_001;
    expect(store.open({ text: 'Done.', voice, speed: 1 })).not.toBe(done);
    expect(store.open({ text: 'Running.', voice, speed: 1 })).toBe(running);
  });

  it('drops the least recently used finished audio when over the byte budget', async () => {
    const { calls, synthesize } = controllableSynth();
    const store = makeStore(synthesize, { maxBytes: 4 });
    const a = store.open({ text: 'A.', voice, speed: 1 });
    const b = store.open({ text: 'B.', voice, speed: 1 });
    await vi.waitFor(() => expect(calls).toHaveLength(2));
    calls[0].resolve(1, 1);
    calls[1].resolve(2, 2, 2, 2);
    await vi.waitFor(() => expect(a.running || b.running).toBe(false));

    // Using A again makes B the oldest, and the two exceed the budget.
    expect(store.open({ text: 'A.', voice, speed: 1 })).toBe(a);
    expect(store.open({ text: 'B.', voice, speed: 1 })).not.toBe(b);
    expect(store.open({ text: 'A.', voice, speed: 1 })).toBe(a);
  });
});
