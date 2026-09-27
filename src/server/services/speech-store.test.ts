import { describe, it, expect, vi } from 'vitest';
import { CHUNK_MAX_LENGTH } from '@/lib/tts';
import type { KokoroVoice } from '@/lib/kokoro-voices';
import { SpeechStore, type Speech, type SynthesizeChunk } from './speech-store';

interface PendingCall {
  text: string;
  resolve: (audio: Uint8Array) => void;
  reject: (error: Error) => void;
}

/** A synthesizer whose calls stay pending until the test settles them. */
function controllableSynth() {
  const calls: PendingCall[] = [];
  const synthesize = vi.fn<SynthesizeChunk>(
    (text) =>
      new Promise<Uint8Array>((resolve, reject) => {
        calls.push({ text, resolve, reject });
      })
  );
  return { calls, synthesize };
}

function makeStore(
  synthesize: SynthesizeChunk,
  overrides: { maxBytes?: number; now?: () => number } = {}
) {
  return new SpeechStore({ synthesize, maxBytes: 1_000_000, ttlMs: 60_000, ...overrides });
}

const voice: KokoroVoice = 'af_heart';
const bytes = (...values: number[]) => new Uint8Array(values);

async function readAll(speech: Speech): Promise<number[]> {
  const out: number[] = [];
  const reader = speech.stream().getReader();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) return out;
    out.push(...value);
  }
}

/** Two sentences that {@link CHUNK_MAX_LENGTH} forces into separate chunks. */
const twoChunkText = `${'a'.repeat(CHUNK_MAX_LENGTH - 2)}. ${'b'.repeat(10)}.`;

describe('SpeechStore', () => {
  it('requests the next chunk before the current one finishes', async () => {
    const { calls, synthesize } = controllableSynth();
    makeStore(synthesize).open({ text: twoChunkText, voice, speed: 1.5 });

    await vi.waitFor(() => expect(calls).toHaveLength(2));
    expect(synthesize).toHaveBeenNthCalledWith(1, expect.stringMatching(/^a+\. $/), voice, 1.5);
    expect(synthesize).toHaveBeenNthCalledWith(2, 'bbbbbbbbbb.', voice, 1.5);
  });

  it('streams chunks in order as they arrive, even when they finish out of order', async () => {
    const { calls, synthesize } = controllableSynth();
    const { speech } = makeStore(synthesize).open({ text: twoChunkText, voice, speed: 1 });
    const all = readAll(speech);

    await vi.waitFor(() => expect(calls).toHaveLength(2));
    calls[1].resolve(bytes(3, 4));
    calls[0].resolve(bytes(1, 2));

    expect(await all).toEqual([1, 2, 3, 4]);
    expect([...(speech.complete() ?? [])]).toEqual([1, 2, 3, 4]);
  });

  it('replays buffered audio to a late reader and then follows along', async () => {
    const { calls, synthesize } = controllableSynth();
    const { speech } = makeStore(synthesize).open({ text: twoChunkText, voice, speed: 1 });
    await vi.waitFor(() => expect(calls).toHaveLength(2));
    calls[0].resolve(bytes(1));
    await speech.ready();
    expect(speech.complete()).toBeNull();

    const late = readAll(speech);
    calls[1].resolve(bytes(2));
    expect(await late).toEqual([1, 2]);
  });

  it('shares one synthesis between identical requests and keeps distinct ids otherwise', async () => {
    const { synthesize } = controllableSynth();
    const store = makeStore(synthesize);
    const first = store.open({ text: 'Hi.', voice, speed: 1 });
    const again = store.open({ text: 'Hi.', voice, speed: 1 });
    const faster = store.open({ text: 'Hi.', voice, speed: 2 });

    expect(again.id).toBe(first.id);
    expect(faster.id).not.toBe(first.id);
    expect(synthesize).toHaveBeenCalledTimes(2);
    expect(first.id).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(store.get(first.id)).toBe(first.speech);
    expect(store.get('unknown')).toBeUndefined();
  });

  it('rejects ready() when the first chunk fails, and retries on the next open', async () => {
    const { calls, synthesize } = controllableSynth();
    const store = makeStore(synthesize);
    const { id, speech } = store.open({ text: 'Hi.', voice, speed: 1 });
    await vi.waitFor(() => expect(calls).toHaveLength(1));
    calls[0].reject(new Error('provider returned 401'));

    await expect(speech.ready()).rejects.toThrow('401');
    expect(speech.failed).toBe(true);
    const retry = store.open({ text: 'Hi.', voice, speed: 1 });
    expect(retry.id).not.toBe(id);
    expect(synthesize).toHaveBeenCalledTimes(2);
  });

  it('ends the stream with an error when a later chunk fails', async () => {
    const { calls, synthesize } = controllableSynth();
    const { speech } = makeStore(synthesize).open({ text: twoChunkText, voice, speed: 1 });
    await vi.waitFor(() => expect(calls).toHaveLength(2));
    calls[0].resolve(bytes(1));
    calls[1].reject(new Error('timeout'));

    await expect(readAll(speech)).rejects.toThrow('timeout');
    await expect(speech.ready()).resolves.toBeUndefined();
  });

  it('expires ids unused for the TTL, but never a synthesis still running', async () => {
    let now = 0;
    const { calls, synthesize } = controllableSynth();
    const store = makeStore(synthesize, { now: () => now });
    const running = store.open({ text: 'Running.', voice, speed: 1 });
    const done = store.open({ text: 'Done.', voice, speed: 1 });
    await vi.waitFor(() => expect(calls).toHaveLength(2));
    calls[1].resolve(bytes(1));
    await vi.waitFor(() => expect(done.speech.complete()).not.toBeNull());

    now = 60_001;
    expect(store.get(done.id)).toBeUndefined();
    expect(store.get(running.id)).toBe(running.speech);
  });

  it('drops the least recently used finished audio when over the byte budget', async () => {
    const { calls, synthesize } = controllableSynth();
    const store = makeStore(synthesize, { maxBytes: 4 });
    const a = store.open({ text: 'A.', voice, speed: 1 });
    const b = store.open({ text: 'B.', voice, speed: 1 });
    await vi.waitFor(() => expect(calls).toHaveLength(2));
    calls[0].resolve(bytes(1, 1, 1));
    calls[1].resolve(bytes(2, 2, 2));
    await Promise.all([a.speech.ready(), b.speech.ready()]);
    await vi.waitFor(() => expect(b.speech.complete()).not.toBeNull());

    store.get(a.id);
    expect(store.get(b.id)).toBeUndefined();
    expect(store.get(a.id)).toBe(a.speech);
  });
});
