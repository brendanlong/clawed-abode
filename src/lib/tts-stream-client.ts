import { StreamingAudioPlayer, StreamingAudioPlayerCallbacks } from './streaming-audio-player';

export interface TTSStreamOptions {
  text: string;
  token: string | null;
  playerCallbacks?: StreamingAudioPlayerCallbacks;
  /** Called for each decoded audio chunk — collect these for caching. */
  onChunk?: (index: number, aacData: Uint8Array) => void;
}

export interface TTSStreamHandle {
  player: StreamingAudioPlayer;
  /** Resolves when the stream is fully consumed (all chunks appended). */
  done: Promise<void>;
  /** Abort the stream and destroy the player. */
  abort: () => void;
}

/**
 * Start a streaming TTS session via the /api/voice/speak-stream SSE endpoint.
 * Feeds decoded AAC chunks to a StreamingAudioPlayer for near-instant playback.
 */
export function startTTSStream(options: TTSStreamOptions): TTSStreamHandle {
  const { text, token, playerCallbacks, onChunk } = options;
  const abortController = new AbortController();
  const player = new StreamingAudioPlayer(playerCallbacks);

  const done = (async () => {
    const response = await fetch('/api/voice/speak-stream', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(token ? { authorization: `Bearer ${token}` } : {}),
      },
      body: JSON.stringify({ text }),
      signal: abortController.signal,
    });

    if (!response.ok) {
      throw new Error(`Speech stream request failed: ${response.status}`);
    }

    const reader = response.body?.getReader();
    if (!reader) {
      throw new Error('No response body');
    }

    const decoder = new TextDecoder();
    let buffer = '';

    try {
      while (true) {
        const { done: readerDone, value } = await reader.read();
        if (readerDone) break;

        buffer += decoder.decode(value, { stream: true });

        // Parse SSE events from the buffer
        const events = buffer.split('\n\n');
        // Keep the last incomplete event in the buffer
        buffer = events.pop() ?? '';

        for (const eventBlock of events) {
          if (!eventBlock.trim()) continue;

          const lines = eventBlock.split('\n');
          let eventType = '';
          let eventData = '';

          for (const line of lines) {
            if (line.startsWith('event: ')) {
              eventType = line.slice(7);
            } else if (line.startsWith('data: ')) {
              eventData = line.slice(6);
            }
          }

          if (!eventType || !eventData) continue;

          if (eventType === 'chunk') {
            const parsed = JSON.parse(eventData) as { index: number; audio: string };
            const binaryStr = atob(parsed.audio);
            const bytes = new Uint8Array(binaryStr.length);
            for (let i = 0; i < binaryStr.length; i++) {
              bytes[i] = binaryStr.charCodeAt(i);
            }

            onChunk?.(parsed.index, bytes);
            await player.appendChunk(bytes);
          } else if (eventType === 'error') {
            const parsed = JSON.parse(eventData) as { message: string };
            throw new Error(parsed.message);
          } else if (eventType === 'done') {
            await player.finalize();
          }
          // 'metadata' events are informational; no action needed
        }
      }
    } finally {
      reader.releaseLock();
    }
  })();

  // Wrap the done promise to handle abort gracefully
  const safeDone = done.catch((error: unknown) => {
    if (error instanceof DOMException && error.name === 'AbortError') {
      return; // Expected when abort() is called
    }
    player.destroy();
    throw error;
  });

  return {
    player,
    done: safeDone,
    abort: () => {
      abortController.abort();
      player.destroy();
    },
  };
}
