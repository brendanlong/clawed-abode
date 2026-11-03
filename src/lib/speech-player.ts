export interface SpeechItem {
  messageId: string;
  text: string;
}

export interface SpeechPlayerState {
  currentMessageId: string | null;
  /** Waiting for the server to produce the current message's first audio. */
  isLoading: boolean;
  isPlaying: boolean;
  error: { messageId: string; message: string } | null;
}

export const IDLE_SPEECH_STATE: SpeechPlayerState = {
  currentMessageId: null,
  isLoading: false,
  isPlaying: false,
  error: null,
};

/** The parts of an HTMLAudioElement the player drives, so tests can supply a fake. */
export type PlayerAudio = Pick<
  HTMLAudioElement,
  | 'src'
  | 'paused'
  | 'play'
  | 'pause'
  | 'load'
  | 'removeAttribute'
  | 'addEventListener'
  | 'removeEventListener'
  | 'disableRemotePlayback'
>;

/** One message's speech as a fragmented MP4, delivered in pieces as it is encoded. */
export interface SpeechAudio {
  /** MIME type (with codec) for `MediaSource.addSourceBuffer`. */
  mimeType: string;
  pieces: AsyncIterable<Uint8Array>;
}

/** Starts fetching `text`'s speech; stops when `signal` aborts. */
export type OpenSpeech = (text: string, signal: AbortSignal) => Promise<SpeechAudio>;

/** A media source playing on the element, and how to let go of it. */
export interface AttachedSource {
  source: MediaSource;
  release: () => void;
}

/** Points the element at a new media source; null when the browser has no MSE. */
export type AttachMediaSource = (audio: PlayerAudio) => AttachedSource | null;

export const UNSUPPORTED_MESSAGE = "This browser can't play read-aloud audio";

interface ManagedMediaSourceGlobal {
  ManagedMediaSource?: typeof MediaSource;
}

/**
 * The MSE implementation to use: iPhone Safari only has `ManagedMediaSource`
 * (17.1+); everything else has `MediaSource`. Null when neither exists.
 */
export function getMediaSourceClass(): typeof MediaSource | null {
  if (typeof window === 'undefined') return null;
  return (
    (window as ManagedMediaSourceGlobal).ManagedMediaSource ??
    (typeof MediaSource === 'undefined' ? null : MediaSource)
  );
}

function attachMediaSource(audio: PlayerAudio): AttachedSource | null {
  const MediaSourceClass = getMediaSourceClass();
  if (!MediaSourceClass) return null;
  const source = new MediaSourceClass();
  // ManagedMediaSource won't open on an element that could AirPlay without
  // an alternative non-MSE source.
  audio.disableRemotePlayback = true;
  const url = URL.createObjectURL(source);
  audio.src = url;
  return { source, release: () => URL.revokeObjectURL(url) };
}

function whenOpen(source: MediaSource, signal: AbortSignal): Promise<void> {
  if (source.readyState === 'open') return Promise.resolve();
  return new Promise((resolve) => {
    source.addEventListener('sourceopen', () => resolve(), { once: true, signal });
  });
}

/** Runs one SourceBuffer mutation and waits for it to finish. */
function updateBuffer(buffer: SourceBuffer, start: () => void): Promise<void> {
  return new Promise((resolve, reject) => {
    const cleanup = () => {
      buffer.removeEventListener('updateend', onEnd);
      buffer.removeEventListener('error', onError);
    };
    const onEnd = () => {
      cleanup();
      resolve();
    };
    const onError = () => {
      cleanup();
      reject(new Error('Failed to buffer speech audio'));
    };
    buffer.addEventListener('updateend', onEnd);
    buffer.addEventListener('error', onError);
    try {
      start();
    } catch (error) {
      cleanup();
      reject(error);
    }
  });
}

/** 0.1 s of silent 8 kHz 8-bit mono WAV. */
function silentWavDataUri(): string {
  const samples = 800;
  const bytes = new Uint8Array(44 + samples);
  const view = new DataView(bytes.buffer);
  const ascii = (offset: number, text: string) =>
    [...text].forEach((c, i) => view.setUint8(offset + i, c.charCodeAt(0)));
  ascii(0, 'RIFF');
  view.setUint32(4, 36 + samples, true);
  ascii(8, 'WAVEfmt ');
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true); // PCM
  view.setUint16(22, 1, true); // mono
  view.setUint32(24, 8000, true);
  view.setUint32(28, 8000, true);
  view.setUint16(32, 1, true);
  view.setUint16(34, 8, true);
  ascii(36, 'data');
  view.setUint32(40, samples, true);
  bytes.fill(0x80, 44); // 8-bit PCM silence is the midpoint
  return `data:audio/wav;base64,${btoa(String.fromCharCode(...bytes))}`;
}

/**
 * Reads messages aloud through one long-lived audio element, so the OS media
 * controls and lock screen stay attached across messages. Each message gets its
 * own Media Source Extensions stream: its fragmented MP4 is appended to one
 * `SourceBuffer` as it is encoded, so playback starts with the first sentence.
 * Auto-read queues messages.
 */
export class SpeechPlayer {
  private state: SpeechPlayerState = IDLE_SPEECH_STATE;
  private queue: SpeechItem[] = [];
  private current: SpeechItem | null = null;
  /** The current message's media source, once its speech has started arriving. */
  private attached: AttachedSource | null = null;
  /** Covers the current message's request, encoding and buffering. */
  private request: AbortController | null = null;
  /** The element has played during a tap, so iOS lets it play unprompted. */
  private primed = false;
  private priming = false;
  /** The current message is loaded but autoplay was refused. */
  private blocked = false;

  // Events for the silence prime() plays arrive with no current message and are ignored.
  private readonly listeners: [keyof HTMLMediaElementEventMap, () => void][] = [
    ['playing', () => this.ifCurrent(() => this.update({ isPlaying: true, isLoading: false }))],
    ['pause', () => this.ifCurrent(() => this.update({ isPlaying: false }))],
    ['ended', () => this.ifCurrent(() => this.advance())],
    ['error', () => this.ifCurrent(() => this.fail('Audio playback failed'))],
  ];

  constructor(
    private readonly audio: PlayerAudio,
    private readonly openSpeech: OpenSpeech,
    private readonly onChange: (state: SpeechPlayerState) => void,
    private readonly attachSource: AttachMediaSource = attachMediaSource
  ) {
    for (const [event, handler] of this.listeners) audio.addEventListener(event, handler);
  }

  get currentItem(): SpeechItem | null {
    return this.current;
  }

  /**
   * Play `item` now, dropping the queue; the current message toggles pause
   * instead. Call from a tap: the audio arrives after the tap's activation
   * has lapsed, so the element is unlocked with silence first.
   */
  play(item: SpeechItem): void {
    this.queue = [];
    if (this.current?.messageId !== item.messageId) {
      this.playSilence();
      void this.start(item);
    } else if (!this.attached) {
      this.stop();
    } else if (this.audio.paused) {
      this.resume();
    } else {
      this.pause();
    }
  }

  /** Play after whatever is playing or queued. */
  enqueue(item: SpeechItem): void {
    if (this.current) this.queue.push(item);
    else void this.start(item);
  }

  pause(): void {
    this.audio.pause();
  }

  resume(): void {
    if (this.attached) void this.playAudio();
  }

  /** Replay the current message; the server replays finished audio from its cache. */
  restart(): void {
    if (this.attached && this.current) void this.start(this.current);
  }

  /** Skip to the next queued message. */
  next(): void {
    if (this.current) this.advance();
  }

  stop(): void {
    this.queue = [];
    this.reset();
    this.update(IDLE_SPEECH_STATE);
  }

  /**
   * Call on any tap while auto-read is on. iOS only lets an element play
   * without a tap once it has played during one, so this resumes a message
   * whose autoplay was refused, or else unlocks the element with silence.
   */
  prime(): void {
    if (this.blocked) {
      this.blocked = false;
      this.resume();
    } else if (!this.current) {
      this.playSilence();
    }
  }

  private playSilence(): void {
    if (this.primed) return;
    this.primed = true;
    this.priming = true;
    this.audio.src = silentWavDataUri();
    this.audio
      .play()
      .catch(() => {})
      .finally(() => {
        if (!this.priming) return;
        this.priming = false;
        this.clearAudio();
      });
  }

  destroy(): void {
    this.stop();
    for (const [event, handler] of this.listeners) this.audio.removeEventListener(event, handler);
  }

  private async start(item: SpeechItem): Promise<void> {
    this.reset();
    this.current = item;
    const request = new AbortController();
    this.request = request;
    this.update({
      currentMessageId: item.messageId,
      isLoading: true,
      isPlaying: false,
      error: null,
    });

    let speech: SpeechAudio;
    try {
      speech = await this.openSpeech(item.text, request.signal);
    } catch (err) {
      if (!request.signal.aborted) this.fail(err instanceof Error ? err.message : String(err));
      return;
    }
    if (this.request !== request) return;
    const attached = this.attachSource(this.audio);
    if (!attached) {
      this.fail(UNSUPPORTED_MESSAGE);
      return;
    }
    this.attached = attached;
    void this.buffer(attached.source, speech, request.signal);
    await this.playAudio();
  }

  /** Appends the speech to `source` as it arrives, then ends the stream so the element ends. */
  private async buffer(source: MediaSource, speech: SpeechAudio, signal: AbortSignal) {
    try {
      await whenOpen(source, signal);
      if (signal.aborted) return;
      const buffer = source.addSourceBuffer(speech.mimeType);
      buffer.mode = 'sequence';
      let empty = true;
      for await (const piece of speech.pieces) {
        if (signal.aborted) return;
        await updateBuffer(buffer, () => buffer.appendBuffer(piece as Uint8Array<ArrayBuffer>));
        empty = false;
      }
      if (signal.aborted) return;
      if (empty) {
        // Nothing to say; an empty stream may never fire `ended`.
        this.advance();
        return;
      }
      if (source.readyState === 'open') source.endOfStream();
    } catch (err) {
      if (!signal.aborted) this.fail(err instanceof Error ? err.message : 'Audio playback failed');
    }
  }

  private async playAudio(): Promise<void> {
    const attached = this.attached;
    try {
      await this.audio.play();
      this.primed = true;
    } catch (err) {
      if (this.attached !== attached) return; // Superseded by another message or stop.
      // Autoplay refused (no tap yet on iOS): stay loaded and paused so a tap resumes.
      if (err instanceof DOMException && err.name === 'NotAllowedError') {
        this.blocked = true;
        this.update({ isLoading: false, isPlaying: false });
        return;
      }
      if (err instanceof DOMException && err.name === 'AbortError') return;
      this.fail(err instanceof Error ? err.message : 'Audio playback failed');
    }
  }

  private advance(): void {
    const next = this.queue.shift();
    if (next) {
      void this.start(next);
    } else {
      this.reset();
      this.update(IDLE_SPEECH_STATE);
    }
  }

  private fail(message: string): void {
    const messageId = this.current?.messageId;
    this.queue = [];
    this.reset();
    this.update({ ...IDLE_SPEECH_STATE, error: messageId ? { messageId, message } : null });
  }

  /** Abandon the current message and silence the element. */
  private reset(): void {
    this.request?.abort();
    this.request = null;
    this.current = null;
    this.priming = false;
    this.blocked = false;
    this.clearAudio();
  }

  private clearAudio(): void {
    this.audio.pause();
    this.audio.removeAttribute('src');
    this.audio.load();
    this.attached?.release();
    this.attached = null;
  }

  private ifCurrent(handler: () => void): void {
    if (this.current) handler();
  }

  private update(patch: Partial<SpeechPlayerState>): void {
    this.state = { ...this.state, ...patch };
    this.onChange(this.state);
  }
}
