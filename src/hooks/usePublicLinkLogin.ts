import { useEffect } from 'react';
import { publicLinkPath } from '@/lib/public-files';

/**
 * Opens links into the public files server through its one-time-code login, so
 * the browser they open in is signed in even if it doesn't share this one's
 * cookies (an Android PWA opens links in a separate browser). A failed mint
 * falls back to the plain link, whose page offers a sign-in link.
 */
export function usePublicLinkLogin(
  baseUrl: string | null,
  createLoginUrl: (input: { next: string }) => Promise<{ url: string }>
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
      createLoginUrl({ next })
        .then(({ url }) => url)
        .catch(() => anchor.href)
        .then(openInNewWindow);
    };
    document.addEventListener('click', onClick);
    return () => document.removeEventListener('click', onClick);
  }, [baseUrl, createLoginUrl]);
}

/**
 * The window opens after a round trip, which a browser may block as a popup once
 * the tap is too far behind it; navigate this window instead so the tap is never
 * lost (an out-of-scope URL leaves an installed PWA for a browser tab anyway).
 * Not `noopener`, which would make a block undetectable; the opener is cut instead.
 */
function openInNewWindow(url: string): void {
  const opened = window.open(url, '_blank');
  if (opened) opened.opener = null;
  else window.location.assign(url);
}
