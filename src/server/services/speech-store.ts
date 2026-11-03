import { createHash } from 'crypto';
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
 * its bytes as the provider streams them. Pieces may split a sample.
 */
export type SynthesizeChunk = (
  text: string,
  voice: KokoroVoice,
  speed: number
) => AsyncIterable<Uint8Array>;

/**
 * One message's audio as raw PCM, synthesized chunk by chunk. Readers get what
 * is buffered immediately and then follow along live, so any number of
 * requests (a replay while it's still synthesizing) share one synthesis.
 */
export class Speech {
  private readonly chunks: Uint8Array[] = [];
  private state: 'running' | 'done' | 'failed' = 'running';
  private error: Error | null = null;
  private waiters: (() => void)[] = [];
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
 * Synthesize sentence by sentence, in order, with up to `maxInFlight` requests
 * running, passing each request's audio on as it streams in. Runs to
 * completion even if every listener leaves; the result stays cached for a replay.
 */
async function synthesizeInto(
  speech: Speech,
  params: SpeechParams,
  synthesize: SynthesizeChunk,
  maxInFlight: number
): Promise<void> {
  const texts = splitIntoSpeechChunks(params.text);
  const pending: PendingChunk[] = [];
  let started = 0;
  const fill = () => {
    while (started < texts.length && pending.length < maxInFlight) {
      pending.push(new PendingChunk(synthesize(texts[started++], params.voice, params.speed)));
    }
  };
  try {
    fill();
    while (pending.length > 0) {
      // Network reads can split a 16-bit sample; hold an odd byte back so
      // chunks join on sample boundaries. A chunk ending on one drops it.
      let carry: number | null = null;
      for await (const piece of pending[0].read()) {
        const bytes: Uint8Array = carry === null ? piece : prepend(carry, piece);
        const even: number = bytes.length & ~1;
        carry = even < bytes.length ? bytes[even] : null;
        speech.push(bytes.subarray(0, even));
      }
      pending.shift();
      fill();
    }
    speech.finish();
  } catch (err) {
    log.error('Speech synthesis failed', toError(err), { chars: params.text.length });
    speech.fail(toError(err));
  }
}

function prepend(byte: number, bytes: Uint8Array): Uint8Array {
  const joined = new Uint8Array(bytes.length + 1);
  joined[0] = byte;
  joined.set(bytes, 1);
  return joined;
}

interface Entry {
  speech: Speech;
  lastUsedAt: number;
}

export interface SpeechStoreOptions {
  synthesize: SynthesizeChunk;
  /** Finished audio kept for replays, oldest dropped first. Running syntheses are never dropped. */
  maxBytes: number;
  /** How long finished audio is kept after its last use. */
  ttlMs: number;
  /**
   * Requests per message kept running at once. Several hide a hosted provider's
   * per-call latency behind playback; a local CPU server should get one, since
   * parallel requests only compete for its cores and delay the first sentence.
   */
  maxInFlight: number;
  now?: () => number;
}

/** Speech keyed by its text, voice and speed, so replays cost nothing. */
export class SpeechStore {
  private readonly byKey = new Map<string, Entry>();
  private readonly now: () => number;

  constructor(private readonly options: SpeechStoreOptions) {
    this.now = options.now ?? Date.now;
  }

  /** The cached or running speech for `params`, starting synthesis if there is none. */
  open(params: SpeechParams): Speech {
    const key = createHash('sha256')
      .update(JSON.stringify([params.voice, params.speed, params.text]))
      .digest('hex');

    const existing = this.byKey.get(key);
    let speech: Speech;
    if (existing && !this.isExpired(existing) && !existing.speech.failed) {
      speech = existing.speech;
    } else {
      speech = new Speech();
      void synthesizeInto(speech, params, this.options.synthesize, this.options.maxInFlight);
    }
    // Re-inserted, so map order stays least recently used first.
    this.byKey.delete(key);
    this.byKey.set(key, { speech, lastUsedAt: this.now() });
    this.evict(key);
    return speech;
  }

  private isExpired(entry: Entry): boolean {
    return !entry.speech.running && entry.lastUsedAt < this.now() - this.options.ttlMs;
  }

  /** Drop expired entries, then the least recently used until within budget, sparing `keepKey`. */
  private evict(keepKey: string): void {
    let total = 0;
    for (const entry of this.byKey.values()) total += entry.speech.bytes;
    for (const [key, entry] of this.byKey) {
      if (key === keepKey || entry.speech.running) continue;
      if (!this.isExpired(entry) && total <= this.options.maxBytes) continue;
      total -= entry.speech.bytes;
      this.byKey.delete(key);
    }
  }
}
