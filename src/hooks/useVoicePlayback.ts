'use client';

import {
  useState,
  useRef,
  useCallback,
  useEffect,
  useMemo,
  createContext,
  useContext,
} from 'react';

/** Item in the sequential playback queue */
export interface PlaybackQueueItem {
  messageId: string;
  text: string;
}

export interface VoicePlaybackState {
  enabled: boolean;
  isPlaying: boolean;
  currentMessageId: string | null;
  isLoading: boolean;
  supportsPause: boolean;
  play: (messageId: string, text: string) => Promise<void>;
  playSequential: (items: PlaybackQueueItem[]) => void;
  enqueue: (item: PlaybackQueueItem) => void;
  pause: () => void;
  stop: () => void;
  restart: () => Promise<void>;
}

const defaultPlaybackState: VoicePlaybackState = {
  enabled: false,
  isPlaying: false,
  currentMessageId: null,
  isLoading: false,
  supportsPause: false,
  play: async () => {},
  playSequential: () => {},
  enqueue: () => {},
  pause: () => {},
  stop: () => {},
  restart: async () => {},
};

export const VoicePlaybackContext = createContext<VoicePlaybackState>(defaultPlaybackState);

export function useVoicePlaybackContext() {
  return useContext(VoicePlaybackContext);
}

/**
 * Chrome has a bug where utterances over ~15 seconds stop abruptly.
 * Workaround: split text into chunks at sentence boundaries.
 * https://issues.chromium.org/issues/41294170
 */
const CHUNK_MAX_LENGTH = 200;

function splitTextIntoChunks(text: string): string[] {
  if (text.length <= CHUNK_MAX_LENGTH) return [text];

  const chunks: string[] = [];
  let remaining = text;

  while (remaining.length > 0) {
    if (remaining.length <= CHUNK_MAX_LENGTH) {
      chunks.push(remaining);
      break;
    }

    // Try to split at sentence boundary
    let splitIndex = -1;
    const sentenceEnders = ['. ', '! ', '? ', '.\n', '!\n', '?\n'];
    for (const ender of sentenceEnders) {
      const idx = remaining.lastIndexOf(ender, CHUNK_MAX_LENGTH);
      if (idx > 0 && idx > splitIndex) {
        splitIndex = idx + ender.length;
      }
    }

    // Fall back to comma/semicolon
    if (splitIndex <= 0) {
      const commaIdx = remaining.lastIndexOf(', ', CHUNK_MAX_LENGTH);
      const semiIdx = remaining.lastIndexOf('; ', CHUNK_MAX_LENGTH);
      splitIndex = Math.max(commaIdx, semiIdx);
      if (splitIndex > 0) splitIndex += 2;
    }

    // Fall back to space
    if (splitIndex <= 0) {
      splitIndex = remaining.lastIndexOf(' ', CHUNK_MAX_LENGTH);
      if (splitIndex > 0) splitIndex += 1;
    }

    // Last resort: hard split
    if (splitIndex <= 0) {
      splitIndex = CHUNK_MAX_LENGTH;
    }

    chunks.push(remaining.slice(0, splitIndex));
    remaining = remaining.slice(splitIndex);
  }

  return chunks;
}

/**
 * Hook that manages audio playback state for voice TTS using the browser's
 * SpeechSynthesis API. No server calls or API keys needed.
 */
/**
 * Returns a promise that resolves once speechSynthesis voices are available.
 * Chrome loads voices asynchronously; calling speak() before they're ready
 * causes "synthesis-failed". This waits for the voiceschanged event with a timeout.
 */
function waitForVoices(synth: SpeechSynthesis): Promise<SpeechSynthesisVoice[]> {
  const voices = synth.getVoices();
  if (voices.length > 0) return Promise.resolve(voices);

  return new Promise((resolve) => {
    const onChanged = () => {
      const v = synth.getVoices();
      if (v.length > 0) {
        synth.removeEventListener('voiceschanged', onChanged);
        clearTimeout(timer);
        resolve(v);
      }
    };
    // Timeout after 2s — if no voices, resolve empty and let speak() fail gracefully
    const timer = setTimeout(() => {
      synth.removeEventListener('voiceschanged', onChanged);
      resolve(synth.getVoices());
    }, 2000);
    synth.addEventListener('voiceschanged', onChanged);
  });
}

export function useVoicePlayback(
  ttsSpeed: number = 1.0,
  preferredVoiceURI: string | null = null
): VoicePlaybackState {
  const [isPlaying, setIsPlaying] = useState(false);
  const [currentMessageId, setCurrentMessageId] = useState<string | null>(null);
  const [isLoading] = useState(false);

  // Track the current text for restart functionality
  const currentTextRef = useRef<string | null>(null);

  // Keep a ref to the current utterance to prevent Chrome from garbage-collecting it.
  // Chrome GCs unreferenced utterances, causing onend to fire immediately.
  // See https://bugs.chromium.org/p/chromium/issues/detail?id=509488
  const utteranceRef = useRef<SpeechSynthesisUtterance | null>(null);

  // Cached voices list — Chrome loads these asynchronously
  const voicesRef = useRef<SpeechSynthesisVoice[]>([]);

  // Sequential playback queue
  const queueRef = useRef<PlaybackQueueItem[]>([]);
  const playNextFromQueueRef = useRef<() => void>(() => {});
  const isActiveRef = useRef(false);

  // Pause/resume is broken on Firefox (pause acts as cancel) and Android (resume doesn't work)
  const supportsPause = useMemo(() => {
    if (typeof navigator === 'undefined') return false;
    const ua = navigator.userAgent;
    if (ua.includes('Firefox')) return false;
    if (ua.includes('Android')) return false;
    return true;
  }, []);

  // TTS speed ref (avoid stale closures)
  const ttsSpeedRef = useRef(ttsSpeed);
  useEffect(() => {
    ttsSpeedRef.current = ttsSpeed;
  }, [ttsSpeed]);

  // Preferred voice URI ref
  const preferredVoiceURIRef = useRef(preferredVoiceURI);
  useEffect(() => {
    preferredVoiceURIRef.current = preferredVoiceURI;
  }, [preferredVoiceURI]);

  // Pre-load voices on mount so they're ready when user clicks play
  useEffect(() => {
    if (typeof window === 'undefined' || !('speechSynthesis' in window)) return;

    const synth = window.speechSynthesis;
    const loadVoices = () => {
      voicesRef.current = synth.getVoices();
      console.debug('[TTS] voices loaded:', voicesRef.current.length);
    };

    loadVoices();
    synth.addEventListener('voiceschanged', loadVoices);
    return () => {
      synth.removeEventListener('voiceschanged', loadVoices);
    };
  }, []);

  // --- Core speak function ---

  const speakText = useCallback(async (messageId: string, text: string) => {
    if (typeof window === 'undefined' || !('speechSynthesis' in window)) return;

    const synth = window.speechSynthesis;

    // Cancel any ongoing speech, but only if actually speaking/pending
    if (synth.speaking || synth.pending) {
      synth.cancel();
    }

    isActiveRef.current = true;
    setCurrentMessageId(messageId);
    setIsPlaying(true);
    currentTextRef.current = text;

    // Ensure voices are loaded — Chrome loads them asynchronously and
    // speak() fails with "synthesis-failed" if called before they're ready
    if (voicesRef.current.length === 0) {
      console.debug('[TTS] waiting for voices to load...');
      voicesRef.current = await waitForVoices(synth);
    }

    // Pick a voice: user preference > language match > first available
    // May be null if no voices loaded (let the browser use its default)
    const voices = voicesRef.current;
    const prefURI = preferredVoiceURIRef.current;
    const primaryLang = navigator.language.split('-')[0]; // e.g. 'en' from 'en-US'

    const selectedVoice =
      // 1. User's explicit preference
      (prefURI ? voices.find((v) => v.voiceURI === prefURI) : null) ??
      // 2. Local voice matching full locale (e.g. en-US)
      voices.find(
        (v) => v.localService && v.lang.replace('_', '-').startsWith(navigator.language)
      ) ??
      // 3. Local voice matching primary language (e.g. en)
      voices.find((v) => v.localService && v.lang.split(/[-_]/)[0] === primaryLang) ??
      // 4. Any voice matching primary language
      voices.find((v) => v.lang.split(/[-_]/)[0] === primaryLang) ??
      // 5. First available (may be undefined if no voices loaded)
      voices[0] ??
      null;

    if (selectedVoice) {
      console.debug(
        '[TTS] using voice:',
        selectedVoice.name,
        selectedVoice.lang,
        selectedVoice.localService ? '(local)' : '(network)'
      );
    } else {
      console.debug('[TTS] no voice selected, using browser default');
    }

    const chunks = splitTextIntoChunks(text);
    let currentChunk = 0;
    let stopped = false;
    let retriedWithoutVoice = false;

    const speakNextChunk = () => {
      if (stopped) return;

      if (currentChunk >= chunks.length) {
        // All chunks done
        utteranceRef.current = null;
        setIsPlaying(false);
        setCurrentMessageId(null);
        currentTextRef.current = null;
        playNextFromQueueRef.current();
        return;
      }

      const utterance = new SpeechSynthesisUtterance(chunks[currentChunk]);
      utterance.rate = ttsSpeedRef.current;
      // Only set voice if we have one and haven't failed with it already
      if (selectedVoice && !retriedWithoutVoice) {
        utterance.voice = selectedVoice;
      }

      // Store in ref to prevent Chrome from garbage-collecting the utterance
      utteranceRef.current = utterance;

      utterance.onstart = () => {
        console.debug('[TTS] chunk started', currentChunk, '/', chunks.length);
      };

      utterance.onend = () => {
        console.debug('[TTS] chunk ended', currentChunk, '/', chunks.length);
        currentChunk++;
        speakNextChunk();
      };

      utterance.onerror = (event) => {
        console.debug('[TTS] error', event.error, 'chunk', currentChunk);
        if (event.error === 'interrupted' || event.error === 'canceled') {
          // Expected when stopping/switching — don't reset state here,
          // the stop() function handles that.
          return;
        }
        // On synthesis-failed, retry once without setting an explicit voice.
        // Some platforms (especially Android) fail when a voice is explicitly set.
        if (event.error === 'synthesis-failed' && selectedVoice && !retriedWithoutVoice) {
          console.debug('[TTS] retrying without explicit voice...');
          retriedWithoutVoice = true;
          speakNextChunk();
          return;
        }
        stopped = true;
        utteranceRef.current = null;
        queueRef.current = [];
        isActiveRef.current = false;
        setIsPlaying(false);
        setCurrentMessageId(null);
        currentTextRef.current = null;
      };

      console.debug(
        '[TTS] speaking chunk',
        currentChunk,
        '/',
        chunks.length,
        JSON.stringify(chunks[currentChunk].slice(0, 50))
      );
      synth.speak(utterance);
    };

    speakNextChunk();
  }, []);

  // Wire up playNextFromQueue
  useEffect(() => {
    playNextFromQueueRef.current = () => {
      const next = queueRef.current.shift();
      if (next) {
        speakText(next.messageId, next.text);
      } else {
        isActiveRef.current = false;
        setIsPlaying(false);
        setCurrentMessageId(null);
      }
    };
  }, [speakText]);

  const stop = useCallback(() => {
    utteranceRef.current = null;
    if (typeof window !== 'undefined' && 'speechSynthesis' in window) {
      window.speechSynthesis.cancel();
    }
    queueRef.current = [];
    isActiveRef.current = false;
    setIsPlaying(false);
    setCurrentMessageId(null);
    currentTextRef.current = null;
  }, []);

  const pause = useCallback(() => {
    if (typeof window === 'undefined' || !('speechSynthesis' in window)) return;

    if (!supportsPause) {
      // Firefox: pause() acts as cancel() — https://bugzilla.mozilla.org/show_bug.cgi?id=1038508
      // Android: resume() doesn't work — https://issues.chromium.org/issues/40459219
      stop();
      return;
    }

    window.speechSynthesis.pause();
    setIsPlaying(false);
  }, [stop, supportsPause]);

  const restart = useCallback(async () => {
    const text = currentTextRef.current;
    const msgId = currentMessageId;
    if (text && msgId) {
      speakText(msgId, text);
    }
  }, [currentMessageId, speakText]);

  // --- Main play function ---

  const play = useCallback(
    async (messageId: string, text: string) => {
      // Clear any pending queue when user manually plays a message
      queueRef.current = [];

      // If we're playing the same message, toggle pause/play
      if (currentMessageId === messageId) {
        if (isPlaying) {
          pause();
        } else if (typeof window !== 'undefined' && 'speechSynthesis' in window) {
          // Resume (only reachable on platforms where supportsPause is true,
          // since pause() calls stop() on unsupported platforms which clears currentMessageId)
          window.speechSynthesis.resume();
          setIsPlaying(true);
        }
        return;
      }

      speakText(messageId, text);
    },
    [currentMessageId, isPlaying, speakText, pause]
  );

  // --- Sequential playback (auto-read) ---

  const playSequential = useCallback(
    (items: PlaybackQueueItem[]) => {
      if (items.length === 0) return;

      queueRef.current = items.slice(1);
      speakText(items[0].messageId, items[0].text);
    },
    [speakText]
  );

  // --- Enqueue ---

  const enqueue = useCallback(
    (item: PlaybackQueueItem) => {
      if (isActiveRef.current) {
        queueRef.current.push(item);
        return;
      }
      speakText(item.messageId, item.text);
    },
    [speakText]
  );

  // Clean up on unmount
  useEffect(() => {
    return () => {
      utteranceRef.current = null;
      if (typeof window !== 'undefined' && 'speechSynthesis' in window) {
        window.speechSynthesis.cancel();
      }
      queueRef.current = [];
      isActiveRef.current = false;
    };
  }, []);

  return {
    enabled: true,
    isPlaying,
    currentMessageId,
    isLoading,
    supportsPause,
    play,
    playSequential,
    enqueue,
    pause,
    stop,
    restart,
  };
}
