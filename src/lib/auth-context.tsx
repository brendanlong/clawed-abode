'use client';

import type { ReactNode } from 'react';
import { createContext, useContext, useState, useEffect, useCallback } from 'react';
import { getAuthToken, setAuthToken, clearAuthToken } from '@/lib/auth-token';
import { trpc } from '@/lib/trpc';

interface AuthContextType {
  isAuthenticated: boolean;
  token: string | null;
  isLoading: boolean;
  login: (token: string) => void;
  logout: () => void;
}

const AuthContext = createContext<AuthContextType | undefined>(undefined);

const LOGOUT_LOCAL_CLEAR_TIMEOUT_MS = 2000;

interface AuthState {
  token: string | null;
  isLoading: boolean;
}

export function AuthProvider({ children }: { children: ReactNode }) {
  const [authState, setAuthState] = useState<AuthState>({
    token: null,
    isLoading: true,
  });

  useEffect(() => {
    // Restore auth state from localStorage after hydration
    // Using queueMicrotask to avoid synchronous setState in effect (React 19 lint rule)
    queueMicrotask(() => {
      const storedToken = getAuthToken();

      setAuthState({
        token: storedToken,
        isLoading: false,
      });
    });
  }, []);

  // Links to the public files server can't carry the bearer header, so mirror it into a cookie.
  useEffect(() => {
    if (authState.isLoading) return;
    const token = authState.token;
    fetch('/api/auth/public-cookie', {
      method: token ? 'POST' : 'DELETE',
      headers: token ? { Authorization: `Bearer ${token}` } : undefined,
    }).catch(() => {
      // Best-effort: only public-file links depend on it.
    });
  }, [authState]);

  const login = useCallback((newToken: string) => {
    setAuthToken(newToken);
    setAuthState({ token: newToken, isLoading: false });
  }, []);

  const { mutate: revokeServerSession } = trpc.auth.logout.useMutation();
  const logout = useCallback(() => {
    // Revoke server-side first (the request needs the token), then clear locally once
    // the request settles or after a short grace period, so the user is signed out
    // even if the server is unreachable or hangs.
    const clearLocally = () => {
      clearAuthToken();
      setAuthState({ token: null, isLoading: false });
    };
    const fallback = setTimeout(clearLocally, LOGOUT_LOCAL_CLEAR_TIMEOUT_MS);
    revokeServerSession(undefined, {
      onSettled: () => {
        clearTimeout(fallback);
        clearLocally();
      },
    });
  }, [revokeServerSession]);

  return (
    <AuthContext.Provider
      value={{
        isAuthenticated: !!authState.token,
        token: authState.token,
        isLoading: authState.isLoading,
        login,
        logout,
      }}
    >
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth() {
  const context = useContext(AuthContext);
  if (context === undefined) {
    throw new Error('useAuth must be used within an AuthProvider');
  }
  return context;
}
