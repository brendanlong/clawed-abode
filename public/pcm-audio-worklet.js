/**
 * AudioWorklet processor that captures PCM16 audio at the AudioContext sample rate
 * and sends it to the main thread for streaming to the OpenAI Realtime API.
 *
 * The Realtime API requires PCM16 at 24kHz, so the AudioContext should be created
 * with sampleRate: 24000 to avoid resampling.
 */
class PCMAudioProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this._stopped = false;
    this.port.onmessage = (event) => {
      if (event.data.type === 'stop') {
        this._stopped = true;
      }
    };
  }

  process(inputs) {
    if (this._stopped) {
      return false;
    }

    const input = inputs[0];
    if (!input || input.length === 0) {
      return true;
    }

    const channelData = input[0];
    if (!channelData || channelData.length === 0) {
      return true;
    }

    // Convert Float32 [-1, 1] to Int16 [-32768, 32767]
    const pcm16 = new Int16Array(channelData.length);
    for (let i = 0; i < channelData.length; i++) {
      const s = Math.max(-1, Math.min(1, channelData[i]));
      pcm16[i] = s < 0 ? s * 0x8000 : s * 0x7fff;
    }

    // Transfer the buffer to avoid copying
    this.port.postMessage({ type: 'audio', buffer: pcm16.buffer }, [pcm16.buffer]);

    return true;
  }
}

registerProcessor('pcm-audio-processor', PCMAudioProcessor);
