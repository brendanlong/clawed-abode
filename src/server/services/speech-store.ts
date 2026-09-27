import { createHash, randomBytes } from 'crypto';
import { splitIntoSpeechChunks } from '@/lib/tts';
import { stripMp3Metadata } from '@/lib/mp3';
import type { KokoroVoice } from '@/lib/kokoro-voices';
import { createLogger, toError } from '@/lib/logger';

const log = createLogger('speech-store');

export interface SpeechParams {
  text: string;
  voice: KokoroVoice;
  speed: number;
}

/** Synthesize one chunk of text to a complete MP3 file. */
export type SynthesizeChunk = (
  text: string,
  voice: KokoroVoice,
  speed: number
) => Promise<Uint8Array>;

/**
 * One message's audio, synthesized chunk by chunk. Readers get what is buffered
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
 * Requests kept in flight ahead of the chunk being awaited. Chunks are single
 * sentences (a few seconds of audio) while a hosted provider takes seconds per
 * call whatever the length, so one request at a time would stall between sentences.
 */
const MAX_IN_FLIGHT = 4;

/**
 * Synthesize sentence by sentence, in order, with up to {@link MAX_IN_FLIGHT}
 * requests running. Runs to completion even if every listener leaves; the
 * result stays cached for a replay.
 */
async function synthesizeInto(
  speech: Speech,
  params: SpeechParams,
  synthesize: SynthesizeChunk
): Promise<void> {
  const texts = splitIntoSpeechChunks(params.text);
  const pending: Promise<Uint8Array>[] = [];
  let started = 0;
  const fill = () => {
    while (started < texts.length && pending.length < MAX_IN_FLIGHT) {
      const promise = synthesize(texts[started++], params.voice, params.speed);
      // Awaited in order below; this only keeps a failure behind an earlier one from going unhandled.
      promise.catch(() => {});
      pending.push(promise);
    }
  };
  try {
    fill();
    while (pending.length > 0) {
      const audio = await pending[0];
      pending.shift();
      fill();
      speech.push(stripMp3Metadata(audio));
    }
    speech.finish();
  } catch (err) {
    log.error('Speech synthesis failed', toError(err), { chars: params.text.length });
    speech.fail(toError(err));
  }
}

interface Entry {
  key: string;
  speech: Speech;
  lastUsedAt: number;
}

export interface SpeechStoreOptions {
  synthesize: SynthesizeChunk;
  /** Finished audio kept for replays, oldest dropped first. Running syntheses are never dropped. */
  maxBytes: number;
  /** How long an id stays valid after its last use. */
  ttlMs: number;
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
    void synthesizeInto(speech, params, this.options.synthesize);
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
