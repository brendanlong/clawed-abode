'use client';

import type { ReactNode } from 'react';
import { createContext, useContext, useState, useEffect, useCallback } from 'react';
import { getAuthToken, setAuthToken, clearAuthToken } from '@/lib/auth-token';

interface AuthContextType {
  isAuthenticated: boolean;
  token: string | null;
  isLoading: boolean;
  login: (token: string) => void;
  logout: () => void;
}

const AuthContext = createContext<AuthContextType | undefined>(undefined);

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

  const login = useCallback((newToken: string) => {
    setAuthToken(newToken);
    setAuthState({ token: newToken, isLoading: false });
  }, []);

  const logout = useCallback(() => {
    clearAuthToken();
    setAuthState({ token: null, isLoading: false });
  }, []);

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
