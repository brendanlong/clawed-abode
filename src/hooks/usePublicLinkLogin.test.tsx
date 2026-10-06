import { describe, it, expect, vi, afterEach } from 'vitest';
import { renderHook, waitFor } from '@testing-library/react';
import { usePublicLinkLogin } from './usePublicLinkLogin';

const BASE = 'https://h.ts.net:8444';
const ID = '123e4567-e89b-42d3-a456-426614174000';

function addLink(href: string): HTMLAnchorElement {
  const anchor = document.createElement('a');
  anchor.href = href;
  anchor.target = '_blank';
  anchor.innerHTML = '<span>label</span>';
  document.body.appendChild(anchor);
  return anchor;
}

function click(target: Element, init: MouseEventInit = {}): MouseEvent {
  const event = new MouseEvent('click', { bubbles: true, cancelable: true, button: 0, ...init });
  target.dispatchEvent(event);
  return event;
}

afterEach(() => {
  document.body.innerHTML = '';
  vi.restoreAllMocks();
});

describe('usePublicLinkLogin', () => {
  it('opens public links through a login URL for that path, without an opener', async () => {
    const opened = { opener: window } as unknown as Window;
    const open = vi.spyOn(window, 'open').mockReturnValue(opened);
    const createLoginUrl = vi.fn().mockResolvedValue({ url: `${BASE}/_login?code=c0de` });
    renderHook(() => usePublicLinkLogin(BASE, createLoginUrl));

    const event = click(addLink(`${BASE}/${ID}/a.html?x=1`).querySelector('span')!);

    expect(event.defaultPrevented).toBe(true);
    expect(createLoginUrl).toHaveBeenCalledWith({ next: `/${ID}/a.html?x=1` });
    await waitFor(() => expect(open).toHaveBeenCalledWith(`${BASE}/_login?code=c0de`, '_blank'));
    expect(opened.opener).toBeNull();
  });

  it('falls back to the plain link when minting fails', async () => {
    const open = vi.spyOn(window, 'open').mockReturnValue({ opener: null } as unknown as Window);
    const createLoginUrl = vi.fn().mockRejectedValue(new Error('offline'));
    renderHook(() => usePublicLinkLogin(BASE, createLoginUrl));

    click(addLink(`${BASE}/${ID}/a.html`));

    await waitFor(() => expect(open).toHaveBeenCalledWith(`${BASE}/${ID}/a.html`, '_blank'));
  });

  it('leaves other links and modified clicks alone', () => {
    const createLoginUrl = vi.fn();
    renderHook(() => usePublicLinkLogin(BASE, createLoginUrl));

    expect(click(addLink('https://example.com/')).defaultPrevented).toBe(false);
    expect(click(addLink(`${BASE}/${ID}/`), { ctrlKey: true }).defaultPrevented).toBe(false);
    expect(createLoginUrl).not.toHaveBeenCalled();
  });

  it('does nothing when public files are not configured', () => {
    const createLoginUrl = vi.fn();
    renderHook(() => usePublicLinkLogin(null, createLoginUrl));

    expect(click(addLink(`${BASE}/${ID}/`)).defaultPrevented).toBe(false);
  });
});
