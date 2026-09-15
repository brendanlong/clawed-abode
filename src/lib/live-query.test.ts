import { describe, it, expect } from 'vitest';
import { QueryClient, QueryObserver, type QueryKey } from '@tanstack/react-query';
import { LIVE_QUERY_OPTIONS, STREAM_ERROR_RESYNC_META, resyncLiveQueries } from './live-query';

/** Subscribe (mounting the query) and resolve once its fetch has settled. */
function mount<K extends QueryKey>(
  observer: QueryObserver<number, Error, number, number, K>
): Promise<() => void> {
  return new Promise((resolve) => {
    const unsubscribe = observer.subscribe((result) => {
      if (result.isSuccess && !result.isFetching) resolve(unsubscribe);
    });
  });
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
  // The SSE stream that maintains these caches is subscribed by the same component
  // as the queries, so an unmounted query's cache is stale by construction and a
  // remount has to go back to the server rather than trust it.
  it('refetches on remount, so an unmaintained cache is never trusted', async () => {
    const queryClient = new QueryClient();
    let served = 1;

    const observe = () =>
      new QueryObserver(queryClient, {
        queryKey: ['live'],
        queryFn: async () => served,
        ...LIVE_QUERY_OPTIONS,
      });

    const unsubscribeFirst = await mount(observe());
    expect(queryClient.getQueryData(['live'])).toBe(1);
    unsubscribeFirst();

    // While nothing was mounted the stream died and the server state moved on.
    served = 2;

    // `subscribe` kicks the refetch off synchronously, so this pins the mount
    // refetch itself rather than waiting on a promise that never settles without it.
    const remounted = observe();
    const settled = mount(remounted);
    expect(remounted.getCurrentResult().isFetching).toBe(true);

    const unsubscribeSecond = await settled;
    expect(queryClient.getQueryData(['live'])).toBe(2);
    unsubscribeSecond();
  });
});
