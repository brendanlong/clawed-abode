import { useCallback, useState } from 'react';

/**
 * Tracks the latest failure across a group of mutations so the UI can show it.
 * Spread `handlersFor(action)` into each mutation's options; starting any of them
 * clears the previous error.
 */
export function useActionError() {
  const [error, setError] = useState<string | null>(null);

  const handlersFor = useCallback(
    (action: string) => ({
      onMutate: () => setError(null),
      onError: (err: { message: string }) => setError(`Failed to ${action}: ${err.message}`),
    }),
    []
  );

  const dismiss = useCallback(() => setError(null), []);

  return { error, dismiss, handlersFor };
}
