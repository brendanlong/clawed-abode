import { describe, it, expect } from 'vitest';
import { defaultBranchFirst } from './branch-list';

describe('defaultBranchFirst', () => {
  it('moves the default branch to the front', () => {
    expect(defaultBranchFirst(['a', 'main', 'z'], 'main')).toEqual(['main', 'a', 'z']);
  });

  it('adds the default branch when it was cut off by pagination', () => {
    expect(defaultBranchFirst(['a', 'b'], 'main')).toEqual(['main', 'a', 'b']);
  });

  it('leaves an empty repository empty', () => {
    expect(defaultBranchFirst([], 'main')).toEqual([]);
  });
});
