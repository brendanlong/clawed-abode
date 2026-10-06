import { useEffect } from 'react';
import { publicLinkPath, publicLoginUrl } from '@/lib/public-files';

/**
 * Opens links into the public files server through its one-time-code login, so
 * the browser they open in is signed in even if it doesn't share this one's
 * cookies (an Android PWA opens links in a separate browser). A failed mint
 * falls back to the plain link, which shows the login page.
 */
export function usePublicLinkLogin(
  baseUrl: string | null,
  createCode: () => Promise<{ code: string }>
): void {
  useEffect(() => {
    if (!baseUrl) return;
    const onClick = (event: MouseEvent) => {
      // Modified clicks open background tabs, which is a desktop browser that shares our cookies.
      if (event.defaultPrevented || event.button !== 0) return;
      if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
      const anchor = event.target instanceof Element ? event.target.closest('a[href]') : null;
      if (!(anchor instanceof HTMLAnchorElement)) return;
      const next = publicLinkPath(anchor.href, baseUrl);
      if (next === null) return;

      event.preventDefault();
      // Opened after a round trip; browsers still allow it this soon after the tap.
      createCode()
        .then(({ code }) => publicLoginUrl(baseUrl, code, next))
        .catch(() => anchor.href)
        .then((url) => window.open(url, '_blank', 'noopener,noreferrer'));
    };
    document.addEventListener('click', onClick);
    return () => document.removeEventListener('click', onClick);
  }, [baseUrl, createCode]);
}
