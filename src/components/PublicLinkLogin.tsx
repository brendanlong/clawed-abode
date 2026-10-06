'use client';

import { useAuth } from '@/lib/auth-context';
import { trpc } from '@/lib/trpc';
import { usePublicLinkLogin } from '@/hooks/usePublicLinkLogin';

/** Mounted once, app-wide: links to public files can appear in any message. Renders nothing. */
export function PublicLinkLogin() {
  const { isAuthenticated } = useAuth();
  const { data } = trpc.auth.publicFilesUrl.useQuery(undefined, {
    enabled: isAuthenticated,
    staleTime: Infinity,
  });
  const { mutateAsync } = trpc.auth.createPublicLoginUrl.useMutation();
  usePublicLinkLogin(data?.url ?? null, mutateAsync);
  return null;
}
