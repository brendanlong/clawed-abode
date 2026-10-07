import { describe, it, expect } from 'vitest';
import { parseViewedSessionId, isActivelyWatching } from './attention-notification';

describe('parseViewedSessionId', () => {
  it('extracts the id from a session path', () => {
    expect(parseViewedSessionId('/session/abc-123')).toBe('abc-123');
  });

  it('extracts the id when the path has trailing segments or query/hash', () => {
    expect(parseViewedSessionId('/session/abc-123/')).toBe('abc-123');
    expect(parseViewedSessionId('/session/abc-123?foo=1')).toBe('abc-123');
    expect(parseViewedSessionId('/session/abc-123#top')).toBe('abc-123');
  });

  it('returns null for non-session routes', () => {
    expect(parseViewedSessionId('/')).toBeNull();
    expect(parseViewedSessionId('/new')).toBeNull();
    expect(parseViewedSessionId('/settings')).toBeNull();
    expect(parseViewedSessionId('/sessions')).toBeNull();
  });

  it('returns null for empty/nullish input', () => {
    expect(parseViewedSessionId(null)).toBeNull();
    expect(parseViewedSessionId(undefined)).toBeNull();
    expect(parseViewedSessionId('')).toBeNull();
  });
});

describe('isActivelyWatching', () => {
  it('is true when the session is on screen and the tab is visible', () => {
    expect(isActivelyWatching({ sessionId: 'a', viewedSessionId: 'a', tabHidden: false })).toBe(
      true
    );
  });

  it('is false when the session is on screen but the tab is hidden', () => {
    expect(isActivelyWatching({ sessionId: 'a', viewedSessionId: 'a', tabHidden: true })).toBe(
      false
    );
  });

  it('is false when a different session is on screen', () => {
    expect(isActivelyWatching({ sessionId: 'a', viewedSessionId: 'b', tabHidden: false })).toBe(
      false
    );
  });

  it('is false when no session is on screen (e.g. home page)', () => {
    expect(isActivelyWatching({ sessionId: 'a', viewedSessionId: null, tabHidden: false })).toBe(
      false
    );
  });
});
