import { describe, it, expect } from 'vitest';
import { buildRepoChoices } from './repo-list';

const NO_REPO = { fullName: '__no_repo__' };
const repos = [{ fullName: 'a/one' }, { fullName: 'EleutherAI/bergson' }, { fullName: 'b/two' }];

function names(opts: Partial<Parameters<typeof buildRepoChoices>[0]>): string[] {
  return buildRepoChoices({
    repos,
    favorites: new Set(),
    query: '',
    noRepoEntry: NO_REPO,
    noRepoSearchText: 'No Repository workspace',
    ...opts,
  }).matches.map((r) => r.fullName);
}

describe('buildRepoChoices', () => {
  it('matches partial names and owners case-insensitively', () => {
    expect(names({ query: 'ber' })).toEqual(['EleutherAI/bergson']);
    expect(names({ query: 'eleuther' })).toEqual(['EleutherAI/bergson']);
  });

  it('puts favorites first and the no-repo entry just after them', () => {
    expect(names({ favorites: new Set(['b/two']) })).toEqual([
      'b/two',
      '__no_repo__',
      'a/one',
      'EleutherAI/bergson',
    ]);
  });

  it('puts a favorited no-repo entry at the very top', () => {
    expect(names({ favorites: new Set(['b/two', '__no_repo__']) })[0]).toBe('__no_repo__');
  });

  it('shows the no-repo entry only when the query matches it', () => {
    expect(names({ query: 'workspace' })).toEqual(['__no_repo__']);
  });

  it('caps GitHub repos but keeps the selected one', () => {
    const result = buildRepoChoices({
      repos,
      favorites: new Set(),
      query: 'o',
      noRepoEntry: NO_REPO,
      noRepoSearchText: 'No Repository workspace',
      selectedFullName: 'b/two',
      limit: 1,
    });
    expect(result.matches.map((r) => r.fullName)).toEqual(['__no_repo__', 'b/two']);
    expect(result.total).toBe(3);
  });
});
