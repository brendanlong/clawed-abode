import { describe, it, expect } from 'vitest';
import { capMatches, matchesAllTerms } from './search';

describe('matchesAllTerms', () => {
  it('requires every term as a case-insensitive substring', () => {
    expect(matchesAllTerms('fix/CUDA-rng-replay', 'cuda fix')).toBe(true);
    expect(matchesAllTerms('fix/cuda-rng-replay', 'cuda main')).toBe(false);
  });

  it('matches everything for a blank query', () => {
    expect(matchesAllTerms('anything', '  ')).toBe(true);
  });

  it('does not fuzzy-match scattered letters', () => {
    expect(matchesAllTerms('feature/image-x', 'fix')).toBe(false);
  });
});

describe('capMatches', () => {
  it('keeps the first `limit` items and reports the total', () => {
    expect(capMatches(['a', 'b', 'c'], 2)).toEqual({ matches: ['a', 'b'], total: 3 });
  });

  it('pins a selected item that falls past the cap to the front', () => {
    expect(capMatches(['a', 'b', 'c', 'd'], 2, (x) => x === 'd')).toEqual({
      matches: ['d', 'a'],
      total: 4,
    });
  });

  it('leaves a pinned item within the cap where it is', () => {
    expect(capMatches(['a', 'b', 'c'], 2, (x) => x === 'b').matches).toEqual(['a', 'b']);
  });
});
