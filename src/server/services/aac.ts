import {
  AdtsOutputFormat,
  AppendOnlyStreamTarget,
  AudioSample,
  AudioSampleSource,
  Output,
  Quality,
} from 'mediabunny';
import { registerAacEncoder } from '@mediabunny/aac-encoder';

/**
 * Speech audio as served to the browser: AAC-LC in ADTS. ADTS is a plain run
 * of self-describing frames, like MP3, so a plain `<audio>` element plays it
 * while it is still being written; an MP4 can't be played until it is
 * finished, since its index (`moov`) needs every frame's size.
 */
export const AAC_CONTENT_TYPE = 'audio/aac';

/** Plenty for mono speech: ~6 KB per second, an eighth of 24 kHz 16-bit PCM. */
const BITRATE = 48_000;

let registered = false;

/**
 * Encodes mono speech (samples in [-1, 1]) to AAC-LC in ADTS as it arrives,
 * yielding bytes as the encoder writes them. The encoder is libavcodec
 * compiled to WASM (`@mediabunny/aac-encoder`), and runs in a worker thread
 * of its own, so encoding never blocks the event loop; the worker ends with
 * the encode. Stopping iteration early stops pulling `pcm`.
 */
export async function* encodeAac(
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
    if (!stopped) await output.finalize();
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
    if (!finished && !failed) {
      // The reader stopped early: stop pulling speech now, and end the worker.
      stopped = true;
      void input.return?.(undefined).catch(() => {});
      void output.cancel().catch(() => {});
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
