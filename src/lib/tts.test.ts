import { describe, it, expect } from 'vitest';
import {
  CHUNK_MAX_LENGTH,
  splitTextIntoChunks,
  selectVoice,
  dedupeAndSortVoices,
  searchVoices,
  VOICE_PICKER_LIMIT,
  type VoiceLike,
} from './tts';

describe('splitTextIntoChunks', () => {
  it('returns short text as a single chunk', () => {
    expect(splitTextIntoChunks('Hello world.')).toEqual(['Hello world.']);
    expect(splitTextIntoChunks('')).toEqual(['']);
  });

  it('never produces a chunk over the limit and reassembles to the input', () => {
    const text = Array.from({ length: 40 }, (_, i) => `Sentence number ${i} is here.`).join(' ');
    const chunks = splitTextIntoChunks(text);
    expect(chunks.length).toBeGreaterThan(1);
    for (const chunk of chunks) expect(chunk.length).toBeLessThanOrEqual(CHUNK_MAX_LENGTH);
    expect(chunks.join('')).toBe(text);
  });

  it('prefers sentence boundaries', () => {
    const first = 'A'.repeat(150) + '. ';
    const second = 'B'.repeat(100) + '.';
    const chunks = splitTextIntoChunks(first + second);
    expect(chunks).toEqual([first, second]);
  });

  it('treats a newline after punctuation as a sentence boundary', () => {
    const first = 'A'.repeat(150) + '?\n';
    const second = 'B'.repeat(100);
    expect(splitTextIntoChunks(first + second)).toEqual([first, second]);
  });

  it('breaks at the last sentence end that fits, not an earlier one', () => {
    const first = 'A'.repeat(100) + '. ? ';
    const second = 'B'.repeat(150);
    expect(splitTextIntoChunks(first + second)).toEqual([first, second]);
  });

  it('keeps a sentence end inside the chunk rather than overflowing the limit', () => {
    const fits = 'A'.repeat(CHUNK_MAX_LENGTH - 2) + '. ';
    expect(splitTextIntoChunks(fits + 'B'.repeat(100))).toEqual([fits, 'B'.repeat(100)]);

    // The '. ' starts exactly at CHUNK_MAX_LENGTH, so it cannot fit in this chunk.
    const overflowing = 'A'.repeat(CHUNK_MAX_LENGTH) + '. ' + 'B'.repeat(100);
    const chunks = splitTextIntoChunks(overflowing);
    for (const chunk of chunks) expect(chunk.length).toBeLessThanOrEqual(CHUNK_MAX_LENGTH);
    expect(chunks.join('')).toBe(overflowing);
  });

  it('keeps a comma or semicolon inside the chunk rather than overflowing the limit', () => {
    for (const delimiter of [', ', '; ']) {
      const text = 'A'.repeat(CHUNK_MAX_LENGTH) + delimiter + 'B'.repeat(100);
      const chunks = splitTextIntoChunks(text);
      for (const chunk of chunks) expect(chunk.length).toBeLessThanOrEqual(CHUNK_MAX_LENGTH);
      expect(chunks.join('')).toBe(text);
    }
  });

  it('keeps a space inside the chunk rather than overflowing the limit', () => {
    const text = 'A'.repeat(CHUNK_MAX_LENGTH) + ' ' + 'B'.repeat(100);
    const chunks = splitTextIntoChunks(text);
    for (const chunk of chunks) expect(chunk.length).toBeLessThanOrEqual(CHUNK_MAX_LENGTH);
    expect(chunks.join('')).toBe(text);
  });

  it('falls back to a comma or semicolon when there is no sentence end', () => {
    const first = 'a'.repeat(120) + ', ';
    const second = 'b'.repeat(150);
    expect(splitTextIntoChunks(first + second)).toEqual([first, second]);
  });

  it('falls back to a space when there is no punctuation', () => {
    const words = Array.from({ length: 60 }, () => 'word').join(' ');
    const chunks = splitTextIntoChunks(words);
    for (const chunk of chunks.slice(0, -1)) expect(chunk.endsWith(' ')).toBe(true);
    expect(chunks.join('')).toBe(words);
  });

  it('hard-splits a single unbroken token', () => {
    const token = 'x'.repeat(CHUNK_MAX_LENGTH * 2 + 10);
    const chunks = splitTextIntoChunks(token);
    expect(chunks.map((c) => c.length)).toEqual([CHUNK_MAX_LENGTH, CHUNK_MAX_LENGTH, 10]);
  });
});

function voice(voiceURI: string, lang: string, localService = true): VoiceLike & { name: string } {
  return { voiceURI, lang, localService, name: voiceURI };
}

describe('selectVoice', () => {
  const voices = [
    voice('fr-remote', 'fr-FR', false),
    voice('en-remote', 'en-US', false),
    voice('en-gb-local', 'en_GB'),
    voice('en-us-local', 'en-US'),
    voice('de-local', 'de-DE'),
  ];

  it('returns null when no voices are loaded', () => {
    expect(selectVoice([], 'anything', 'en-US')).toBeNull();
  });

  it('honours the user preference when it exists', () => {
    expect(selectVoice(voices, 'de-local', 'en-US')?.voiceURI).toBe('de-local');
  });

  it('ignores a preference that no longer exists', () => {
    expect(selectVoice(voices, 'gone', 'en-US')?.voiceURI).toBe('en-us-local');
  });

  it('prefers a local voice matching the full locale', () => {
    expect(selectVoice(voices, null, 'en-US')?.voiceURI).toBe('en-us-local');
  });

  it('falls back to a local voice for the primary language, normalizing underscores', () => {
    expect(selectVoice(voices, null, 'en-AU')?.voiceURI).toBe('en-gb-local');
  });

  it('falls back to a remote voice for the primary language when no local one exists', () => {
    expect(selectVoice(voices, null, 'fr-CA')?.voiceURI).toBe('fr-remote');
  });

  it('falls back to the first voice when nothing matches the language', () => {
    expect(selectVoice(voices, null, 'ja-JP')?.voiceURI).toBe('fr-remote');
  });
});

describe('dedupeAndSortVoices', () => {
  it('drops duplicate URIs and sorts by language then name', () => {
    const result = dedupeAndSortVoices([
      { ...voice('b', 'en-US'), name: 'Zed' },
      { ...voice('a', 'de-DE'), name: 'Anna' },
      { ...voice('b', 'en-US'), name: 'Zed' },
      { ...voice('c', 'en-US'), name: 'Alex' },
    ]);
    expect(result.map((v) => v.voiceURI)).toEqual(['a', 'c', 'b']);
  });
});

describe('searchVoices', () => {
  const voices = [
    { ...voice('de-anna', 'de-DE'), name: 'Anna' },
    { ...voice('en-alex', 'en-US'), name: 'Alex' },
    { ...voice('en-gb-brian', 'en-GB'), name: 'Brian' },
    { ...voice('fr-amelie', 'fr-FR'), name: 'Amélie' },
  ];

  it('lists voices for the locale language first, then the rest in input order', () => {
    const { matches, total } = searchVoices(voices, '', 'en-AU');
    expect(matches.map((v) => v.voiceURI)).toEqual([
      'en-alex',
      'en-gb-brian',
      'de-anna',
      'fr-amelie',
    ]);
    expect(total).toBe(4);
  });

  it('requires every term to match the name or language, case-insensitively', () => {
    expect(searchVoices(voices, 'AN', 'en-US').matches.map((v) => v.voiceURI)).toEqual([
      'en-gb-brian',
      'de-anna',
    ]);
    expect(searchVoices(voices, 'an gb', 'en-US').matches.map((v) => v.voiceURI)).toEqual([
      'en-gb-brian',
    ]);
    expect(searchVoices(voices, 'zzz', 'en-US')).toEqual({ matches: [], total: 0 });
  });

  it('keeps input order when the locale is empty or missing', () => {
    const uris = voices.map((v) => v.voiceURI);
    expect(searchVoices(voices, '', '').matches.map((v) => v.voiceURI)).toEqual(uris);
    expect(searchVoices(voices, '', undefined).matches.map((v) => v.voiceURI)).toEqual(uris);
  });

  const many = Array.from({ length: 200 }, (_, i) => ({
    ...voice(`v${i}`, i % 2 === 0 ? 'en-US' : 'es-ES'),
    name: `Voice ${i}`,
  }));

  it('caps the matches while reporting the uncapped total', () => {
    const { matches, total } = searchVoices(many, '', 'es', null, 10);
    expect(matches).toHaveLength(10);
    expect(matches.every((v) => v.lang === 'es-ES')).toBe(true);
    expect(total).toBe(200);
  });

  it('moves a pinned voice that fell past the cap to the front', () => {
    const { matches } = searchVoices(many, '', 'es', 'v198', 10);
    expect(matches[0].voiceURI).toBe('v198');
    expect(matches).toHaveLength(10);
    // A pinned voice already inside the cap stays where it was.
    expect(searchVoices(many, '', 'es', 'v3', 10).matches[1].voiceURI).toBe('v3');
    // A pinned voice that doesn't match the query is not forced in.
    expect(
      searchVoices(many, 'voice 1', 'es', 'v0', 10).matches.some((v) => v.voiceURI === 'v0')
    ).toBe(false);
  });

  it('defaults the cap to VOICE_PICKER_LIMIT', () => {
    const lots = Array.from({ length: VOICE_PICKER_LIMIT + 5 }, (_, i) => voice(`v${i}`, 'en'));
    expect(searchVoices(lots, '', 'en').matches).toHaveLength(VOICE_PICKER_LIMIT);
  });
});
