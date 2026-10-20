import { describe, it, expect } from 'vitest';
import { QueryClient, QueryObserver, type QueryKey } from '@tanstack/react-query';
import { LIVE_QUERY_OPTIONS } from './live-query';

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

describe('LIVE_QUERY_OPTIONS', () => {
  // Nothing maintains an unmounted query's cache, so it is stale by construction
  // and a remount has to go back to the server rather than trust it.
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
