import { useEffect, useRef, useState } from 'react';

interface UseInfiniteScrollOptions {
  hasMore: boolean;
  isLoading: boolean;
  /** The last load failed: wait for the sentinel to scroll into view again. */
  loadFailed: boolean;
  onLoadMore: () => void;
  /** How far outside the root the sentinel still counts as visible. */
  rootMargin?: string;
}

/**
 * Loads the next page when a sentinel element scrolls into view within a scroll
 * container (or the viewport, when `rootRef` is left unattached).
 *
 * The observer is created once per root/sentinel pair and reads the latest
 * options through a ref. Rebuilding it whenever the loading state changed would
 * make the new observer's initial entry reload at once, so a failing server
 * would be asked again back to back. Instead, a load starts only on an
 * intersection, and after a successful load the sentinel is checked once more
 * (re-observing it delivers a fresh entry after layout), so a short page that
 * leaves it in view keeps loading. After a failed load nothing happens until
 * the sentinel next enters view.
 *
 * Both refs are callback refs, so a sentinel that mounts later is picked up.
 */
export function useInfiniteScroll({
  hasMore,
  isLoading,
  loadFailed,
  onLoadMore,
  rootMargin = '100px',
}: UseInfiniteScrollOptions) {
  const [root, rootRef] = useState<HTMLElement | null>(null);
  const [sentinel, sentinelRef] = useState<HTMLElement | null>(null);
  const latest = useRef({ hasMore, isLoading, onLoadMore });
  useEffect(() => {
    latest.current = { hasMore, isLoading, onLoadMore };
  });

  const observerRef = useRef<IntersectionObserver | null>(null);
  useEffect(() => {
    if (!sentinel) return;
    const observer = new IntersectionObserver(
      (entries) => {
        const { hasMore, isLoading, onLoadMore } = latest.current;
        if (entries.some((entry) => entry.isIntersecting) && hasMore && !isLoading) onLoadMore();
      },
      { root, rootMargin }
    );
    observer.observe(sentinel);
    observerRef.current = observer;
    return () => {
      observer.disconnect();
      observerRef.current = null;
    };
  }, [root, sentinel, rootMargin]);

  // Each time loading becomes possible again (a page landed, or there is newly
  // more to load), look at the sentinel once more — unless the load failed.
  const canLoad = hasMore && !isLoading;
  useEffect(() => {
    const observer = observerRef.current;
    if (!canLoad || loadFailed || !observer || !sentinel) return;
    observer.unobserve(sentinel);
    observer.observe(sentinel);
  }, [canLoad, loadFailed, sentinel]);

  return { rootRef, sentinelRef };
}
