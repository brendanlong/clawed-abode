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
>;

/** Resolves to a URL the audio element can stream `text` from. */
export type RequestSpeechUrl = (text: string, signal: AbortSignal) => Promise<string>;

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
 * controls and lock screen stay attached across messages. Each message is a
 * separate stream URL; auto-read queues them.
 */
export class SpeechPlayer {
  private state: SpeechPlayerState = IDLE_SPEECH_STATE;
  private queue: SpeechItem[] = [];
  private current: SpeechItem | null = null;
  private url: string | null = null;
  private request: AbortController | null = null;
  private primed = false;
  private priming = false;

  // Events for the silence prime() plays arrive with no current message and are ignored.
  private readonly listeners: [keyof HTMLMediaElementEventMap, () => void][] = [
    ['playing', () => this.ifCurrent(() => this.update({ isPlaying: true, isLoading: false }))],
    ['pause', () => this.ifCurrent(() => this.update({ isPlaying: false }))],
    ['ended', () => this.ifCurrent(() => this.advance())],
    ['error', () => this.ifCurrent(() => this.fail('Audio playback failed'))],
  ];

  constructor(
    private readonly audio: PlayerAudio,
    private readonly requestUrl: RequestSpeechUrl,
    private readonly onChange: (state: SpeechPlayerState) => void
  ) {
    for (const [event, handler] of this.listeners) audio.addEventListener(event, handler);
  }

  get currentItem(): SpeechItem | null {
    return this.current;
  }

  /** Play `item` now, dropping the queue; the current message toggles pause instead. */
  play(item: SpeechItem): void {
    this.queue = [];
    if (this.current?.messageId !== item.messageId) {
      void this.start(item);
    } else if (!this.url) {
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
    if (this.url) void this.playAudio();
  }

  /** Replay the current message; the server replays finished audio from its cache. */
  restart(): void {
    if (!this.url) return;
    this.audio.src = this.url;
    void this.playAudio();
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
   * iOS only lets an element play without a tap once it has played during one,
   * so auto-read plays silence on the first tap anywhere.
   */
  prime(): void {
    if (this.primed || this.current) return;
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

    let url: string;
    try {
      url = await this.requestUrl(item.text, request.signal);
    } catch (err) {
      if (!request.signal.aborted) this.fail(err instanceof Error ? err.message : String(err));
      return;
    }
    if (this.request !== request) return;
    this.request = null;
    this.url = url;
    this.audio.src = url;
    await this.playAudio();
  }

  private async playAudio(): Promise<void> {
    const url = this.url;
    try {
      await this.audio.play();
    } catch (err) {
      if (this.url !== url) return; // Superseded by another message or stop.
      // Autoplay refused (no tap yet on iOS): stay loaded and paused so a tap resumes.
      if (err instanceof DOMException && err.name === 'NotAllowedError') {
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
    this.url = null;
    this.priming = false;
    this.clearAudio();
  }

  private clearAudio(): void {
    this.audio.pause();
    this.audio.removeAttribute('src');
    this.audio.load();
  }

  private ifCurrent(handler: () => void): void {
    if (this.current) handler();
  }

  private update(patch: Partial<SpeechPlayerState>): void {
    this.state = { ...this.state, ...patch };
    this.onChange(this.state);
  }
}
