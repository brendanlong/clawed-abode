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
  it('opens public links through a one-time login code', async () => {
    const open = vi.spyOn(window, 'open').mockReturnValue(null);
    const createCode = vi.fn().mockResolvedValue({ code: 'c0de' });
    renderHook(() => usePublicLinkLogin(BASE, createCode));

    const event = click(addLink(`${BASE}/${ID}/a.html`).querySelector('span')!);

    expect(event.defaultPrevented).toBe(true);
    await waitFor(() => expect(open).toHaveBeenCalledTimes(1));
    const url = new URL(open.mock.calls[0][0] as string);
    expect(url.pathname).toBe('/_login');
    expect(url.searchParams.get('code')).toBe('c0de');
    expect(url.searchParams.get('next')).toBe(`/${ID}/a.html`);
  });

  it('falls back to the plain link when minting fails', async () => {
    const open = vi.spyOn(window, 'open').mockReturnValue(null);
    const createCode = vi.fn().mockRejectedValue(new Error('offline'));
    renderHook(() => usePublicLinkLogin(BASE, createCode));

    click(addLink(`${BASE}/${ID}/a.html`));

    await waitFor(() =>
      expect(open).toHaveBeenCalledWith(`${BASE}/${ID}/a.html`, '_blank', 'noopener,noreferrer')
    );
  });

  it('leaves other links and modified clicks alone', () => {
    const createCode = vi.fn();
    renderHook(() => usePublicLinkLogin(BASE, createCode));

    expect(click(addLink('https://example.com/')).defaultPrevented).toBe(false);
    expect(click(addLink(`${BASE}/${ID}/`), { ctrlKey: true }).defaultPrevented).toBe(false);
    expect(createCode).not.toHaveBeenCalled();
  });

  it('does nothing when public files are not configured', () => {
    const createCode = vi.fn();
    renderHook(() => usePublicLinkLogin(null, createCode));

    expect(click(addLink(`${BASE}/${ID}/`)).defaultPrevented).toBe(false);
  });
});
