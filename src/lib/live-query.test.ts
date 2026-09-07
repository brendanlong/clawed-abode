import { describe, it, expect } from 'vitest';
import { QueryClient, QueryObserver } from '@tanstack/react-query';
import { LIVE_QUERY_OPTIONS, STREAM_ERROR_RESYNC_META, resyncLiveQueries } from './live-query';

/** Subscribe (mounting the query) and resolve once its first fetch succeeds. */
function mount(observer: QueryObserver<number>): Promise<() => void> {
  return new Promise((resolve) => {
    const unsubscribe = observer.subscribe((result) => {
      if (result.isSuccess) resolve(unsubscribe);
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
