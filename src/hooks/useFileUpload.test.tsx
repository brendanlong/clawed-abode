import { describe, it, expect, afterEach, vi } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { useFileUpload } from './useFileUpload';

const SESSION_ID = 'a0eebc99-9c0b-4ef8-bb6d-6bb9bd380a11';

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('useFileUpload', () => {
  it('sends each file as a raw body and keeps successes when another file fails', async () => {
    const fetchMock = vi.fn(async (url: string, init: RequestInit) => {
      const name = new URL(url, 'http://localhost').searchParams.get('name');
      if (name === 'bad.txt') {
        return Response.json({ error: 'Session is not running' }, { status: 409 });
      }
      expect(init.body).toBeInstanceOf(File);
      return Response.json({
        attachment: { name, storedName: `0000abcd-${name}`, path: `/uploads/0000abcd-${name}` },
      });
    });
    vi.stubGlobal('fetch', fetchMock);

    const { result } = renderHook(() => useFileUpload(SESSION_ID));
    let uploaded: Awaited<ReturnType<typeof result.current.upload>> = [];
    await act(async () => {
      uploaded = await result.current.upload([
        new File(['a'], 'good.txt'),
        new File(['b'], 'bad.txt'),
      ]);
    });

    expect(fetchMock).toHaveBeenCalledTimes(2);
    const params = new URL(fetchMock.mock.calls[0][0], 'http://localhost').searchParams;
    expect(params.get('sessionId')).toBe(SESSION_ID);
    expect(params.get('name')).toBe('good.txt');
    expect(uploaded.map((a) => a.name)).toEqual(['good.txt']);
    expect(result.current.error).toBe('bad.txt: Session is not running');
    expect(result.current.uploading).toBe(false);
  });

  it('stages uploads when there is no session yet', async () => {
    const fetchMock = vi.fn(async (url: string) => {
      const name = new URL(url, 'http://localhost').searchParams.get('name');
      return Response.json({
        attachment: { name, storedName: `0000abcd-${name}`, path: `/staging/0000abcd-${name}` },
      });
    });
    vi.stubGlobal('fetch', fetchMock);

    const { result } = renderHook(() => useFileUpload());
    await act(async () => {
      await result.current.upload([new File(['a'], 'a.txt')]);
    });

    const params = new URL(fetchMock.mock.calls[0][0], 'http://localhost').searchParams;
    expect(params.has('sessionId')).toBe(false);
    expect(params.get('name')).toBe('a.txt');
  });
});
