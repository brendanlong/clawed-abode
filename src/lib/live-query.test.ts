import { describe, it, expect } from 'vitest';
import { QueryClient, QueryObserver, type QueryKey } from '@tanstack/react-query';
import { LIVE_QUERY_OPTIONS, STREAM_ERROR_RESYNC_META, resyncLiveQueries } from './live-query';

/** Subscribe (mounting the query) and resolve once it has data, fetched or cached. */
function mount<K extends QueryKey>(
  observer: QueryObserver<number, Error, number, number, K>
): Promise<() => void> {
  return new Promise((resolve) => {
    const unsubscribe = observer.subscribe((result) => {
      if (result.isSuccess) resolve(unsubscribe);
    });
    if (observer.getCurrentResult().isSuccess) resolve(unsubscribe);
  });
}

/** Let any refetch a mount kicked off run to completion. */
function flushPendingFetches(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

describe('resyncLiveQueries', () => {
  it('refetches only mounted queries tagged for stream-error resync', async () => {
    const queryClient = new QueryClient();
    const calls = { live: 0, plain: 0, unmounted: 0 };

    const live = new QueryObserver(queryClient, {
      queryKey: ['live'],
      queryFn: async () => ++calls.live,
      ...LIVE_QUERY_OPTIONS,
    });
    const plain = new QueryObserver(queryClient, {
      queryKey: ['plain'],
      queryFn: async () => ++calls.plain,
    });
    const unmounted = new QueryObserver(queryClient, {
      queryKey: ['unmounted'],
      queryFn: async () => ++calls.unmounted,
      meta: STREAM_ERROR_RESYNC_META,
    });
    const [unsubscribeLive, unsubscribePlain, unsubscribeUnmounted] = await Promise.all([
      mount(live),
      mount(plain),
      mount(unmounted),
    ]);
    unsubscribeUnmounted();
    expect(calls).toEqual({ live: 1, plain: 1, unmounted: 1 });

    await resyncLiveQueries(queryClient);

    expect(calls).toEqual({ live: 2, plain: 1, unmounted: 1 });
    unsubscribeLive();
    unsubscribePlain();
  });
});

describe('LIVE_QUERY_OPTIONS', () => {
  it('does not refetch on remount, so a stale read cannot clobber the live value', async () => {
    const queryClient = new QueryClient();
    let calls = 0;

    const observe = () =>
      new QueryObserver(queryClient, {
        queryKey: ['live'],
        queryFn: async () => ++calls,
        ...LIVE_QUERY_OPTIONS,
      });

    const unsubscribeFirst = await mount(observe());
    expect(calls).toBe(1);
    unsubscribeFirst();

    // The SSE stream wrote a newer value into the cache while nothing was mounted.
    queryClient.setQueryData(['live'], 99);

    const remounted = observe();
    const unsubscribeSecond = await mount(remounted);
    expect(remounted.getCurrentResult().isFetching).toBe(false);
    await flushPendingFetches();

    expect(calls).toBe(1);
    expect(queryClient.getQueryData(['live'])).toBe(99);
    unsubscribeSecond();
  });
});
