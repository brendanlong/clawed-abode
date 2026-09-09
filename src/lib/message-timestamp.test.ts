import { describe, it, expect } from 'vitest';
import { formatMessageTimestamp, formatFullTimestamp } from './message-timestamp';

// Local-time constructors so the same-day comparison is timezone-independent.
const now = new Date(2026, 8, 8, 16, 5);

describe('formatMessageTimestamp', () => {
  it('shows only the time for a message from today', () => {
    expect(formatMessageTimestamp(new Date(2026, 8, 8, 15, 42), now, 'en-US')).toBe('3:42 PM');
  });

  it('pads minutes', () => {
    expect(formatMessageTimestamp(new Date(2026, 8, 8, 9, 3), now, 'en-US')).toBe('9:03 AM');
  });

  it('adds the date for a message from another day this year', () => {
    expect(formatMessageTimestamp(new Date(2026, 8, 7, 23, 59), now, 'en-US')).toBe(
      'Sep 7, 11:59 PM'
    );
  });

  it('treats the same time of day on a different day as not today', () => {
    expect(formatMessageTimestamp(new Date(2026, 7, 8, 16, 5), now, 'en-US')).toBe(
      'Aug 8, 4:05 PM'
    );
  });

  it('adds the year for a message from another year', () => {
    expect(formatMessageTimestamp(new Date(2025, 11, 31, 8, 0), now, 'en-US')).toBe(
      'Dec 31, 2025, 8:00 AM'
    );
  });
});

describe('formatFullTimestamp', () => {
  it('always includes the full date', () => {
    expect(formatFullTimestamp(new Date(2026, 8, 8, 15, 42), 'en-US')).toBe('Sep 8, 2026, 3:42 PM');
  });
});
