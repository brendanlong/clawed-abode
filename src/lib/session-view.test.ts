import { describe, it, expect } from 'vitest';
import { toSessionView } from './session-view';

const actions = (status: string) => {
  const { canStart, canStop, canArchive } = toSessionView({ status, pullRequest: null });
  return { canStart, canStop, canArchive };
};

describe('toSessionView', () => {
  it.each([
    ['running', { canStart: false, canStop: true, canArchive: true }],
    ['stopped', { canStart: true, canStop: false, canArchive: true }],
    ['creating', { canStart: false, canStop: false, canArchive: true }],
    ['error', { canStart: false, canStop: false, canArchive: true }],
    ['archived', { canStart: false, canStop: false, canArchive: false }],
    ['hibernating', { canStart: false, canStop: false, canArchive: false }],
  ])('offers the actions the transition table allows from %s', (status, expected) => {
    expect(actions(status)).toEqual(expected);
  });

  it('decodes the pull request and drops prCheckedAt', () => {
    const view = toSessionView({ status: 'running', pullRequest: '{not json', prCheckedAt: null });
    expect(view.pullRequest).toBeNull();
    expect(view).not.toHaveProperty('prCheckedAt');
  });
});
