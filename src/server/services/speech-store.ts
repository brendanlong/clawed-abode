import { createHash, randomBytes } from 'crypto';
import { splitIntoSpeechChunks } from '@/lib/tts';
import type { KokoroVoice } from '@/lib/kokoro-voices';
import { createLogger, toError } from '@/lib/logger';

const log = createLogger('speech-store');

export interface SpeechParams {
  text: string;
  voice: KokoroVoice;
  speed: number;
}

/**
 * Synthesize one chunk of text to raw 16-bit little-endian mono PCM, yielding
 * its bytes as the provider streams them. Pieces may split a sample. Stop
 * (and fail) when `signal` aborts.
 */
export type SynthesizeChunk = (
  text: string,
  voice: KokoroVoice,
  speed: number,
  signal: AbortSignal
) => AsyncIterable<Uint8Array>;

/**
 * One message's encoded audio, synthesized chunk by chunk. Readers get what is buffered
 * immediately and then follow along live, so any number of requests (a replay,
 * a browser's probe-then-fetch) share one synthesis.
 */
export class Speech {
  private readonly chunks: Uint8Array[] = [];
  private state: 'running' | 'done' | 'failed' = 'running';
  private error: Error | null = null;
  private waiters: (() => void)[] = [];
  private whole: Uint8Array<ArrayBuffer> | null = null;
  bytes = 0;

  get running(): boolean {
    return this.state === 'running';
  }

  get failed(): boolean {
    return this.state === 'failed';
  }

  push(chunk: Uint8Array): void {
    if (chunk.length === 0) return;
    this.chunks.push(chunk);
    this.bytes += chunk.length;
    this.notify();
  }

  finish(): void {
    this.whole = new Uint8Array(this.bytes);
    let offset = 0;
    for (const chunk of this.chunks) {
      this.whole.set(chunk, offset);
      offset += chunk.length;
    }
    this.state = 'done';
    this.notify();
  }

  fail(error: Error): void {
    this.state = 'failed';
    this.error = error;
    this.notify();
  }

  /** Resolves once there is audio to play (or synthesis ended empty); rejects if it failed first. */
  async ready(): Promise<void> {
    while (this.chunks.length === 0 && this.state === 'running') await this.changed();
    if (this.chunks.length === 0 && this.error) throw this.error;
  }

  /** The whole file once synthesis is done, else null. */
  complete(): Uint8Array<ArrayBuffer> | null {
    return this.whole;
  }

  stream(): ReadableStream<Uint8Array> {
    let index = 0;
    return new ReadableStream<Uint8Array>({
      pull: async (controller) => {
        while (index >= this.chunks.length && this.state === 'running') await this.changed();
        if (index < this.chunks.length) {
          controller.enqueue(this.chunks[index++]);
        } else if (this.error) {
          controller.error(this.error);
        } else {
          controller.close();
        }
      },
    });
  }

  private changed(): Promise<void> {
    return new Promise((resolve) => this.waiters.push(resolve));
  }

  private notify(): void {
    const waiters = this.waiters;
    this.waiters = [];
    for (const resolve of waiters) resolve();
  }
}

/**
 * One request's bytes, collected as they arrive whether or not anyone is
 * reading yet, so requests running ahead of the one playing don't stall.
 */
class PendingChunk {
  private readonly pieces: Uint8Array[] = [];
  private done = false;
  private error: Error | null = null;
  private waiters: (() => void)[] = [];

  constructor(source: AsyncIterable<Uint8Array>) {
    void this.drain(source);
  }

  async *read(): AsyncGenerator<Uint8Array> {
    let index = 0;
    for (;;) {
      if (index < this.pieces.length) yield this.pieces[index++];
      else if (this.error) throw this.error;
      else if (this.done) return;
      else await new Promise<void>((resolve) => this.waiters.push(resolve));
    }
  }

  private async drain(source: AsyncIterable<Uint8Array>): Promise<void> {
    try {
      for await (const piece of source) {
        this.pieces.push(piece);
        this.wake();
      }
      this.done = true;
    } catch (err) {
      this.error = toError(err);
    }
    this.wake();
  }

  private wake(): void {
    for (const resolve of this.waiters.splice(0)) resolve();
  }
}

/**
 * The message's PCM, sentence by sentence in order, with up to `maxInFlight`
 * requests running, passing each request's audio on as it streams in.
 * Network reads can split a 16-bit sample, so an odd byte is held back until
 * the next piece and sentences join on sample boundaries; a sentence that ends
 * on one drops it.
 */
async function* orderedPcm(
  params: SpeechParams,
  synthesize: SynthesizeChunk,
  maxInFlight: number,
  signal: AbortSignal
): AsyncGenerator<Uint8Array> {
  const texts = splitIntoSpeechChunks(params.text);
  const pending: PendingChunk[] = [];
  let started = 0;
  const fill = () => {
    while (started < texts.length && pending.length < maxInFlight) {
      const text = texts[started++];
      pending.push(new PendingChunk(synthesize(text, params.voice, params.speed, signal)));
    }
  };
  fill();
  while (pending.length > 0) {
    let carry: number | null = null;
    for await (const piece of pending[0].read()) {
      const bytes: Uint8Array = carry === null ? piece : prepend(carry, piece);
      const even: number = bytes.length & ~1;
      carry = even < bytes.length ? bytes[even] : null;
      if (even > 0) yield bytes.subarray(0, even);
    }
    pending.shift();
    fill();
  }
}

function prepend(byte: number, bytes: Uint8Array): Uint8Array {
  const joined = new Uint8Array(bytes.length + 1);
  joined[0] = byte;
  joined.set(bytes, 1);
  return joined;
}

/**
 * Synthesize and encode the whole message. Runs to completion even if every
 * listener leaves; the result stays cached for a replay.
 */
async function synthesizeInto(
  speech: Speech,
  params: SpeechParams,
  options: SpeechStoreOptions
): Promise<void> {
  const requests = new AbortController();
  try {
    const pcm = orderedPcm(params, options.synthesize, options.maxInFlight, requests.signal);
    for await (const bytes of options.encode(pcm)) speech.push(bytes);
    speech.finish();
  } catch (err) {
    log.error('Speech synthesis failed', toError(err), { chars: params.text.length });
    speech.fail(toError(err));
  } finally {
    // After a failure, requests still in flight would only be thrown away.
    // Aborting them also ends the PCM generator if it was waiting on one.
    requests.abort();
  }
}

interface Entry {
  key: string;
  speech: Speech;
  lastUsedAt: number;
}

export interface SpeechStoreOptions {
  synthesize: SynthesizeChunk;
  /**
   * Encodes the message's PCM for playback as it arrives. Pulls it as fast as
   * it can encode, so the PCM held at once is bounded by the requests in flight.
   */
  encode: (pcm: AsyncIterable<Uint8Array>) => AsyncIterable<Uint8Array>;
  /** Finished audio kept for replays, oldest dropped first. Running syntheses are never dropped. */
  maxBytes: number;
  /** How long an id stays valid after its last use. */
  ttlMs: number;
  /**
   * Requests per message kept running at once. Several hide a hosted provider's
   * per-call latency behind playback; a local CPU server should get one, since
   * parallel requests only compete for its cores and delay the first sentence.
   */
  maxInFlight: number;
  now?: () => number;
}

/**
 * Speech keyed by an unguessable id. The id is the only credential for the
 * unauthenticated audio URL, so it is random rather than derived from the text;
 * identical requests reuse the same entry so replays cost nothing.
 */
export class SpeechStore {
  private readonly byId = new Map<string, Entry>();
  private readonly idByKey = new Map<string, string>();
  private readonly now: () => number;

  constructor(private readonly options: SpeechStoreOptions) {
    this.now = options.now ?? Date.now;
  }

  open(params: SpeechParams): { id: string; speech: Speech } {
    const key = createHash('sha256')
      .update(JSON.stringify([params.voice, params.speed, params.text]))
      .digest('hex');

    const existingId = this.idByKey.get(key);
    const existing = existingId === undefined ? undefined : this.get(existingId);
    if (existingId !== undefined && existing && !existing.failed) {
      return { id: existingId, speech: existing };
    }

    const id = randomBytes(32).toString('base64url');
    const speech = new Speech();
    this.byId.set(id, { key, speech, lastUsedAt: this.now() });
    this.idByKey.set(key, id);
    this.evict(id);
    void synthesizeInto(speech, params, this.options);
    return { id, speech };
  }

  get(id: string): Speech | undefined {
    const speech = this.touch(id);
    this.evict(id);
    return speech;
  }

  /** Refresh a live entry's expiry and move it to the back of the eviction order. */
  private touch(id: string): Speech | undefined {
    const entry = this.byId.get(id);
    if (!entry || this.isExpired(entry)) return undefined;
    this.byId.delete(id);
    entry.lastUsedAt = this.now();
    this.byId.set(id, entry);
    return entry.speech;
  }

  private isExpired(entry: Entry): boolean {
    return !entry.speech.running && entry.lastUsedAt < this.now() - this.options.ttlMs;
  }

  /** Drop expired entries, then the least recently used until within budget, sparing `keepId`. */
  private evict(keepId: string): void {
    let total = 0;
    for (const entry of this.byId.values()) total += entry.speech.bytes;
    // Map iteration is least-recently-used first.
    for (const [id, entry] of this.byId) {
      if (id === keepId || entry.speech.running) continue;
      if (!this.isExpired(entry) && total <= this.options.maxBytes) continue;
      total -= entry.speech.bytes;
      this.byId.delete(id);
      if (this.idByKey.get(entry.key) === id) this.idByKey.delete(entry.key);
    }
  }
}
