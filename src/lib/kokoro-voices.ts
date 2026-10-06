import { z } from 'zod';

/**
 * Kokoro's built-in voices. An id's first letter is its language and the second
 * its gender, e.g. `af_heart` is an American English female voice.
 */
export const KOKORO_VOICES = [
  'af_alloy',
  'af_aoede',
  'af_bella',
  'af_heart',
  'af_jessica',
  'af_kore',
  'af_nicole',
  'af_nova',
  'af_river',
  'af_sarah',
  'af_sky',
  'am_adam',
  'am_echo',
  'am_eric',
  'am_fenrir',
  'am_liam',
  'am_michael',
  'am_onyx',
  'am_puck',
  'am_santa',
  'bf_alice',
  'bf_emma',
  'bf_isabella',
  'bf_lily',
  'bm_daniel',
  'bm_fable',
  'bm_george',
  'bm_lewis',
  'ef_dora',
  'em_alex',
  'em_santa',
  'ff_siwis',
  'hf_alpha',
  'hf_beta',
  'hm_omega',
  'hm_psi',
  'if_sara',
  'im_nicola',
  'jf_alpha',
  'jf_gongitsune',
  'jf_nezumi',
  'jf_tebukuro',
  'jm_kumo',
  'pf_dora',
  'pm_alex',
  'pm_santa',
  'zf_xiaobei',
  'zf_xiaoni',
  'zf_xiaoxiao',
  'zf_xiaoyi',
  'zm_yunjian',
  'zm_yunxi',
  'zm_yunxia',
  'zm_yunyang',
] as const;

export type KokoroVoice = (typeof KOKORO_VOICES)[number];

export const DEFAULT_KOKORO_VOICE: KokoroVoice = 'af_heart';

/** Playback speed when none is saved. */
export const DEFAULT_TTS_SPEED = 1.0;

export const kokoroVoiceSchema = z.enum(KOKORO_VOICES);

/** The stored voice, or the default when unset or no longer a known voice. */
export function resolveKokoroVoice(stored: string | null | undefined): KokoroVoice {
  return kokoroVoiceSchema.catch(DEFAULT_KOKORO_VOICE).parse(stored ?? DEFAULT_KOKORO_VOICE);
}

const LANGUAGES: Record<string, string> = {
  a: 'American English',
  b: 'British English',
  e: 'Spanish',
  f: 'French',
  h: 'Hindi',
  i: 'Italian',
  j: 'Japanese',
  p: 'Brazilian Portuguese',
  z: 'Mandarin Chinese',
};

export interface KokoroVoiceGroup {
  language: string;
  voices: { id: KokoroVoice; label: string }[];
}

/** `af_heart` → `Heart (female)`. */
export function kokoroVoiceLabel(id: KokoroVoice): string {
  const name = id.slice(3);
  const gender = id[1] === 'f' ? 'female' : 'male';
  return `${name.charAt(0).toUpperCase()}${name.slice(1)} (${gender})`;
}

/** Voices grouped by language, in {@link KOKORO_VOICES} order. */
export function groupKokoroVoices(): KokoroVoiceGroup[] {
  const groups = new Map<string, KokoroVoiceGroup>();
  for (const id of KOKORO_VOICES) {
    const language = LANGUAGES[id[0]];
    let group = groups.get(language);
    if (!group) {
      group = { language, voices: [] };
      groups.set(language, group);
    }
    group.voices.push({ id, label: kokoroVoiceLabel(id) });
  }
  return [...groups.values()];
}
