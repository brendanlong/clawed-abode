'use client';

import { trpc } from '@/lib/trpc';

/**
 * Returns a callback that marks `globalSettings.get` stale, for any mutation
 * that changes global settings; every card reading those settings refetches.
 */
export function useInvalidateGlobalSettings() {
  const utils = trpc.useUtils();
  return () => utils.globalSettings.get.invalidate();
}

/** `globalSettings.update`, refreshing the global settings once it succeeds. */
export function useUpdateGlobalSettings() {
  const invalidate = useInvalidateGlobalSettings();
  return trpc.globalSettings.update.useMutation({ onSuccess: invalidate });
}
