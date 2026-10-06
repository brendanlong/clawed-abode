import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { useEffect } from 'react';
import { act, render, waitFor } from '@testing-library/react';
import { AuthProvider, useAuth } from './auth-context';
import { setAuthToken } from './auth-token';

interface MutateOptions {
  onSettled?: () => void;
}

vi.mock('@/lib/trpc', () => ({
  trpc: {
    auth: {
      logout: {
        useMutation: () => ({
          mutate: (_input: undefined, options: MutateOptions) => options.onSettled?.(),
        }),
      },
    },
  },
}));

const fetchMock = vi.fn();
const latest: { auth: ReturnType<typeof useAuth> | null } = { auth: null };
const capture = (auth: ReturnType<typeof useAuth>) => {
  latest.auth = auth;
};

function Probe({ onAuth = capture }: { onAuth?: typeof capture }) {
  const auth = useAuth();
  useEffect(() => onAuth(auth));
  return null;
}

beforeEach(() => {
  localStorage.clear();
  latest.auth = null;
  fetchMock.mockReset().mockResolvedValue(new Response(null, { status: 204 }));
  vi.stubGlobal('fetch', fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

function cookieCalls() {
  return fetchMock.mock.calls
    .filter(([url]) => url === '/api/auth/public-cookie')
    .map(([, init]) => (init as RequestInit).method);
}

describe('AuthProvider public files cookie', () => {
  it('mirrors a stored token into the cookie', async () => {
    setAuthToken('tok');
    render(
      <AuthProvider>
        <Probe />
      </AuthProvider>
    );
    await waitFor(() => expect(cookieCalls()).toEqual(['POST']));
  });

  it('leaves the cookie alone without a token, so a public-files-only sign-in can be upgraded', async () => {
    render(
      <AuthProvider>
        <Probe />
      </AuthProvider>
    );
    await waitFor(() => expect(latest.auth?.isLoading).toBe(false));
    expect(cookieCalls()).toEqual([]);
  });

  it('clears the cookie on logout', async () => {
    setAuthToken('tok');
    render(
      <AuthProvider>
        <Probe />
      </AuthProvider>
    );
    await waitFor(() => expect(latest.auth?.isAuthenticated).toBe(true));

    act(() => latest.auth!.logout());

    await waitFor(() => expect(cookieCalls()).toEqual(['POST', 'DELETE']));
  });
});
