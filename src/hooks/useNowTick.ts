'use client';

import { useEffect, useState } from 'react';

/** How often the clock advances. Fine enough for minute-resolution countdowns. */
const TICK_MS = 30_000;

/**
 * The current time, re-read on a timer so relative countdowns ("resumes in about
 * 3 hours") stay honest without a server round-trip. `Date.now()` can't be called
 * during render — a re-render would silently move it — so it is seeded once in
 * state and advanced from an interval.
 */
export function useNowTick(): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), TICK_MS);
    return () => clearInterval(timer);
  }, []);
  return now;
}
