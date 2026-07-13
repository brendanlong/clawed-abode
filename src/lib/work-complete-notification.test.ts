import { describe, it, expect } from 'vitest';
import { parseViewedSessionId, shouldNotifyOnRunningChange } from './work-complete-notification';

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

describe('shouldNotifyOnRunningChange', () => {
  it('notifies on a working -> idle transition of an unwatched session', () => {
    expect(
      shouldNotifyOnRunningChange({ wasRunning: true, nowRunning: false, isWatching: false })
    ).toBe(true);
  });

  it('does not notify when the finished session is being watched', () => {
    expect(
      shouldNotifyOnRunningChange({ wasRunning: true, nowRunning: false, isWatching: true })
    ).toBe(false);
  });

  it('does not notify on an idle -> working transition', () => {
    expect(
      shouldNotifyOnRunningChange({ wasRunning: false, nowRunning: true, isWatching: false })
    ).toBe(false);
  });

  it('does not notify when the previous state is unknown (first event seen)', () => {
    expect(
      shouldNotifyOnRunningChange({ wasRunning: undefined, nowRunning: false, isWatching: false })
    ).toBe(false);
  });

  it('does not notify on a repeated idle state', () => {
    expect(
      shouldNotifyOnRunningChange({ wasRunning: false, nowRunning: false, isWatching: false })
    ).toBe(false);
  });
});
