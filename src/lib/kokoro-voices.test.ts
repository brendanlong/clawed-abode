import { describe, it, expect } from 'vitest';
import {
  DEFAULT_KOKORO_VOICE,
  KOKORO_VOICES,
  groupKokoroVoices,
  kokoroVoiceLabel,
  resolveKokoroVoice,
} from './kokoro-voices';

describe('kokoroVoiceLabel', () => {
  it('names the voice and its gender', () => {
    expect(kokoroVoiceLabel('af_heart')).toBe('Heart (female)');
    expect(kokoroVoiceLabel('bm_george')).toBe('George (male)');
  });
});

describe('groupKokoroVoices', () => {
  it('groups every voice under a named language exactly once', () => {
    const groups = groupKokoroVoices();
    expect(groups.flatMap((g) => g.voices.map((v) => v.id))).toEqual([...KOKORO_VOICES]);
    for (const group of groups) expect(group.language).toBeTruthy();
    expect(groups[0]).toMatchObject({ language: 'American English' });
  });
});

describe('resolveKokoroVoice', () => {
  it('keeps a known voice and falls back to the default otherwise', () => {
    expect(resolveKokoroVoice('bf_emma')).toBe('bf_emma');
    expect(resolveKokoroVoice(null)).toBe(DEFAULT_KOKORO_VOICE);
    expect(resolveKokoroVoice('retired_voice')).toBe(DEFAULT_KOKORO_VOICE);
  });
});
