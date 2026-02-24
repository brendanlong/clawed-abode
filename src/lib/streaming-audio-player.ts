import MSEAudioWrapper from 'mse-audio-wrapper';

export interface StreamingAudioPlayerCallbacks {
  onPlaying?: () => void;
  onEnded?: () => void;
  onError?: (error: Error) => void;
}

/**
 * Encapsulates the MSE lifecycle for streaming AAC audio playback.
 * Wraps raw AAC (ADTS) data into fMP4 segments via mse-audio-wrapper
 * and feeds them to a MediaSource SourceBuffer for gapless playback.
 */
export class StreamingAudioPlayer {
  private mediaSource: MediaSource;
  private audio: HTMLAudioElement;
  private sourceBuffer: SourceBuffer | null = null;
  private wrapper: MSEAudioWrapper;
  private segmentQueue: Uint8Array[] = [];
  private finalized = false;
  private destroyed = false;
  private objectUrl: string;
  private sourceOpenPromise: Promise<void>;
  private callbacks: StreamingAudioPlayerCallbacks;
  private hasStartedPlaying = false;

  constructor(callbacks: StreamingAudioPlayerCallbacks = {}) {
    this.callbacks = callbacks;
    this.mediaSource = new MediaSource();
    this.audio = new Audio();
    this.objectUrl = URL.createObjectURL(this.mediaSource);
    this.audio.src = this.objectUrl;

    this.wrapper = new MSEAudioWrapper('audio/aac', {
      preferredContainer: 'fmp4',
      codec: 'aac',
    });

    this.sourceOpenPromise = new Promise<void>((resolve) => {
      this.mediaSource.addEventListener('sourceopen', () => {
        if (this.destroyed) return;
        this.sourceBuffer = this.mediaSource.addSourceBuffer('audio/mp4; codecs="mp4a.40.2"');
        // Use 'sequence' mode so each segment is appended after the previous one,
        // regardless of timestamps in the media. This is critical when concatenating
        // audio from independent TTS calls — their fMP4 segments may have overlapping
        // timestamps which would cause 'segments' mode to overwrite earlier audio.
        this.sourceBuffer.mode = 'sequence';
        this.sourceBuffer.addEventListener('updateend', () => {
          this.drainQueue();
        });
        resolve();
      });
    });

    this.audio.addEventListener('ended', () => {
      if (!this.destroyed) {
        this.callbacks.onEnded?.();
      }
    });

    this.audio.addEventListener('error', () => {
      if (!this.destroyed) {
        const error = this.audio.error;
        this.callbacks.onError?.(
          new Error(error ? `Audio error: ${error.message}` : 'Unknown audio error')
        );
      }
    });
  }

  /**
   * Feed a raw AAC (ADTS) chunk into the player.
   * The chunk is wrapped into fMP4 segments and queued for the SourceBuffer.
   */
  async appendChunk(aacData: Uint8Array): Promise<void> {
    if (this.destroyed || this.finalized) return;

    await this.sourceOpenPromise;

    // Wrap raw AAC into fMP4 segments
    const segments = this.wrapper.iterator(aacData);
    for (const segment of segments) {
      this.segmentQueue.push(segment);
    }

    this.drainQueue();

    // Auto-play once we have data
    if (!this.hasStartedPlaying) {
      this.hasStartedPlaying = true;
      try {
        await this.audio.play();
        this.callbacks.onPlaying?.();
      } catch (e) {
        this.callbacks.onError?.(e instanceof Error ? e : new Error('Playback failed'));
      }
    }
  }

  /**
   * Signal that all chunks have been appended.
   * Calls mediaSource.endOfStream() once the SourceBuffer finishes draining.
   */
  async finalize(): Promise<void> {
    if (this.destroyed || this.finalized) return;
    this.finalized = true;

    await this.sourceOpenPromise;

    // Flush any remaining buffered frames by passing an empty chunk
    // (mse-audio-wrapper may hold frames below the min threshold)
    const flushSegments = this.wrapper.iterator(new Uint8Array(0));
    for (const segment of flushSegments) {
      this.segmentQueue.push(segment);
    }

    this.drainQueue();

    // If nothing is pending, end immediately
    if (this.sourceBuffer && !this.sourceBuffer.updating && this.segmentQueue.length === 0) {
      this.endStream();
    }
    // Otherwise, drainQueue will call endStream after last segment
  }

  private drainQueue(): void {
    if (
      this.destroyed ||
      !this.sourceBuffer ||
      this.sourceBuffer.updating ||
      this.segmentQueue.length === 0
    ) {
      // If finalized and queue is empty and not updating, end stream
      if (
        this.finalized &&
        this.sourceBuffer &&
        !this.sourceBuffer.updating &&
        this.segmentQueue.length === 0 &&
        this.mediaSource.readyState === 'open'
      ) {
        this.endStream();
      }
      return;
    }

    const segment = this.segmentQueue.shift()!;
    try {
      // Copy the segment into its own ArrayBuffer. mse-audio-wrapper may
      // return views into a shared buffer, so we can't pass segment.buffer
      // directly (it would include data from other segments).
      this.sourceBuffer.appendBuffer(new Uint8Array(segment).buffer);
    } catch (e) {
      this.callbacks.onError?.(e instanceof Error ? e : new Error('SourceBuffer append failed'));
    }
  }

  private endStream(): void {
    if (this.mediaSource.readyState === 'open') {
      try {
        this.mediaSource.endOfStream();
      } catch {
        // Ignore — may already be ended
      }
    }
  }

  pause(): void {
    if (!this.destroyed) {
      this.audio.pause();
    }
  }

  resume(): void {
    if (!this.destroyed) {
      this.audio.play().catch(() => {});
    }
  }

  restart(): void {
    if (!this.destroyed) {
      this.audio.currentTime = 0;
      this.audio.play().catch(() => {});
    }
  }

  destroy(): void {
    if (this.destroyed) return;
    this.destroyed = true;
    this.audio.pause();
    this.audio.removeAttribute('src');
    this.audio.load();
    URL.revokeObjectURL(this.objectUrl);
    this.segmentQueue = [];
    this.sourceBuffer = null;
  }
}

/**
 * Check if the browser supports MSE with AAC in fMP4.
 */
export function isMSESupported(): boolean {
  if (typeof MediaSource === 'undefined') return false;
  return MediaSource.isTypeSupported('audio/mp4; codecs="mp4a.40.2"');
}
