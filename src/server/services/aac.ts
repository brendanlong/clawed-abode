import {
  AdtsOutputFormat,
  AppendOnlyStreamTarget,
  AudioSample,
  AudioSampleSource,
  Output,
  Quality,
} from 'mediabunny';
import { registerAacEncoder } from '@mediabunny/aac-encoder';
import { Semaphore } from '@/lib/semaphore';

/**
 * Speech audio as served to the browser: AAC-LC in ADTS. ADTS is a plain run
 * of self-describing frames, like MP3, so a plain `<audio>` element plays it
 * while it is still being written; an MP4 can't be played until it is
 * finished, since its index (`moov`) needs every frame's size.
 */
export const AAC_CONTENT_TYPE = 'audio/aac';

/** Plenty for mono speech: ~6 KB per second, an eighth of 24 kHz 16-bit PCM. */
const BITRATE = 48_000;

/**
 * Encodes running at once, each with its own worker thread (~14 MB). Far
 * faster than realtime, so a few keep up with any number of listeners.
 */
const MAX_CONCURRENT_ENCODES = 4;
const encodeSlots = new Semaphore(MAX_CONCURRENT_ENCODES);

let registered = false;

/**
 * Encodes mono speech (samples in [-1, 1]) to AAC-LC in ADTS as it arrives,
 * yielding bytes as the encoder writes them. The encoder is libavcodec
 * compiled to WASM (`@mediabunny/aac-encoder`), and runs in a worker thread
 * of its own, so encoding never blocks the event loop; the worker ends with
 * the encode, however the encode ends. At most {@link MAX_CONCURRENT_ENCODES}
 * run at once; the rest wait. Stopping iteration early stops pulling `pcm`.
 * Speech with no samples at all yields nothing.
 */
export async function* encodeAac(
  pcm: AsyncIterable<Float32Array>,
  sampleRate: number
): AsyncGenerator<Uint8Array> {
  const release = await encodeSlots.acquire();
  try {
    yield* encodeWithSlot(pcm, sampleRate);
  } finally {
    release();
  }
}

async function* encodeWithSlot(
  pcm: AsyncIterable<Float32Array>,
  sampleRate: number
): AsyncGenerator<Uint8Array> {
  if (!registered) {
    registerAacEncoder();
    registered = true;
  }
  const written: Uint8Array[] = [];
  let wake: (() => void) | null = null;
  const output = new Output({
    format: new AdtsOutputFormat(),
    target: new AppendOnlyStreamTarget(
      new WritableStream({
        write: (bytes) => {
          written.push(bytes);
          wake?.();
        },
      })
    ),
  });
  const source = new AudioSampleSource({
    codec: 'aac',
    // Mediabunny would pick HE-AAC at 24 kHz; plain AAC-LC decodes everywhere.
    fullCodecString: 'mp4a.40.2',
    quality: new Quality({ bitrate: BITRATE }),
  });
  output.addAudioTrack(source);

  const input = pcm[Symbol.asyncIterator]();
  let stopped = false;
  let finished = false;
  let failed = false;
  let failure: unknown;
  const feeding = (async () => {
    await output.start();
    let frames = 0;
    for (let next = await input.next(); !next.done && !stopped; next = await input.next()) {
      if (next.value.length === 0) continue;
      const sample = new AudioSample({
        data: next.value,
        format: 'f32',
        numberOfChannels: 1,
        sampleRate,
        timestamp: frames / sampleRate,
      });
      frames += next.value.length;
      try {
        // Waits for the worker, so a fast producer can't run ahead of the encoder.
        await source.add(sample);
      } finally {
        sample.close();
      }
    }
    if (stopped) return;
    // An encoder that never got a sample has nothing to finalize (and throws if asked).
    if (frames === 0) await output.cancel();
    else await output.finalize();
  })().then(
    () => (finished = true),
    (error: unknown) => {
      failed = true;
      failure = error;
    }
  );
  void feeding.finally(() => wake?.());

  try {
    for (;;) {
      if (written.length > 0) yield concat(written.splice(0));
      else if (failed) throw failure;
      else if (finished) return;
      else await new Promise<void>((resolve) => (wake = resolve));
      wake = null;
    }
  } finally {
    if (!finished) {
      // Stopped early or failed: stop pulling speech, and cancel the output,
      // which is what ends the encoder's worker thread (it would otherwise
      // keep itself alive).
      stopped = true;
      void input.return?.(undefined).catch(() => {});
      await output.cancel().catch(() => {});
    }
  }
}

function concat(pieces: Uint8Array[]): Uint8Array {
  if (pieces.length === 1) return pieces[0];
  const joined = new Uint8Array(pieces.reduce((length, piece) => length + piece.length, 0));
  let offset = 0;
  for (const piece of pieces) {
    joined.set(piece, offset);
    offset += piece.length;
  }
  return joined;
}
