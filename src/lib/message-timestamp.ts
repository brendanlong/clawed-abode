/**
 * Compact timestamp for a transcript row: time-only when the message is from
 * today, with the date added (and the year, once it differs) otherwise, so a
 * long-lived session's older turns stay unambiguous without cluttering today's.
 */
export function formatMessageTimestamp(createdAt: Date, now: Date, locale?: string): string {
  const time: Intl.DateTimeFormatOptions = { hour: 'numeric', minute: '2-digit' };
  if (isSameLocalDay(createdAt, now)) {
    return createdAt.toLocaleTimeString(locale, time);
  }
  const sameYear = createdAt.getFullYear() === now.getFullYear();
  return createdAt.toLocaleString(locale, {
    ...time,
    month: 'short',
    day: 'numeric',
    ...(sameYear ? {} : { year: 'numeric' }),
  });
}

/** The unabbreviated form, for a hover title on the compact one. */
export function formatFullTimestamp(createdAt: Date, locale?: string): string {
  return createdAt.toLocaleString(locale, { dateStyle: 'medium', timeStyle: 'short' });
}

function isSameLocalDay(a: Date, b: Date): boolean {
  return (
    a.getFullYear() === b.getFullYear() &&
    a.getMonth() === b.getMonth() &&
    a.getDate() === b.getDate()
  );
}
