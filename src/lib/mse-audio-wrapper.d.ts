declare module 'mse-audio-wrapper' {
  interface MSEAudioWrapperOptions {
    minFramesPerSegment?: number;
    minBytesPerSegment?: number;
    maxFramesPerSegment?: number;
    preferredContainer?: 'webm' | 'fmp4';
    codec?: 'aac' | 'flac' | 'mpeg' | 'opus' | 'vorbis';
    enableLogging?: boolean;
    onMimeType?: (mimeType: string) => void;
    onCodecUpdate?: (codecInfo: unknown, updateTimestamp: number) => void;
  }

  export default class MSEAudioWrapper {
    constructor(mimeType: string, options?: MSEAudioWrapperOptions);
    get inputMimeType(): string;
    get mimeType(): string;
    iterator(chunk: Uint8Array): Generator<Uint8Array, void, unknown>;
  }

  export function getWrappedMimeType(
    codec: 'aac' | 'flac' | 'mpeg' | 'opus' | 'vorbis',
    container?: 'webm' | 'fmp4'
  ): string;
}
