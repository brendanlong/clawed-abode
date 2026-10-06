'use client';

import { Suspense, useCallback, useState, useEffect, useRef } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { trpc } from '@/lib/trpc';
import { useAuth } from '@/lib/auth-context';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Spinner } from '@/components/ui/spinner';
import { PUBLIC_NEXT_PARAM } from '@/lib/public-files';
import { claimAutomaticReturn } from '@/lib/public-login-loop';

export default function LoginPage() {
  return (
    <Suspense fallback={null}>
      <LoginForm />
    </Suspense>
  );
}

function LoginForm() {
  const router = useRouter();
  // The public files server sends browsers here to sign in, then back to this path.
  const publicNext = useSearchParams().get(PUBLIC_NEXT_PARAM);
  const { login, isAuthenticated, isLoading } = useAuth();
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');

  const { mutate: openPublicFiles } = trpc.auth.createPublicLoginUrl.useMutation({
    onSuccess: ({ url }) => window.location.replace(url),
    onError: (err) => {
      setError(err.message);
    },
  });

  const leave = useCallback(() => {
    if (publicNext === null) router.push('/');
    else openPublicFiles({ next: publicNext });
  }, [publicNext, router, openPublicFiles]);

  const loginMutation = trpc.auth.login.useMutation({
    onSuccess: (data) => {
      login(data.token);
      leave();
    },
    onError: (err) => {
      setError(err.message);
    },
  });

  // Leave right away if this browser arrived signed in. Only on arrival: a stored
  // token may be stale (rejected without clearing auth state), so a later sign-in
  // leaves from onSuccess rather than waiting for isAuthenticated to change.
  const arrivalHandled = useRef(false);
  useEffect(() => {
    if (isLoading || arrivalHandled.current) return;
    arrivalHandled.current = true;
    if (!isAuthenticated) return;
    if (publicNext !== null && !claimAutomaticReturn(window.sessionStorage, publicNext)) {
      // Deferred: setState directly in an effect cascades renders (React 19 lint rule).
      queueMicrotask(() =>
        setError(
          "This browser didn't keep the public files sign-in. Check that PUBLIC_FILES_URL uses this app's hostname."
        )
      );
      return;
    }
    leave();
  }, [isLoading, isAuthenticated, publicNext, leave]);

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    setError('');
    loginMutation.mutate({ password });
  };

  return (
    <div className="min-h-screen flex items-center justify-center bg-background py-12 px-4 sm:px-6 lg:px-8">
      <div className="max-w-md w-full">
        <div className="text-center mb-8">
          <h1 className="text-3xl font-bold">Clawed Abode</h1>
        </div>

        <Card>
          <CardHeader>
            <CardTitle>Sign in</CardTitle>
          </CardHeader>
          <CardContent>
            <form onSubmit={handleSubmit} className="space-y-4">
              {error && (
                <Alert variant="destructive">
                  <AlertDescription>{error}</AlertDescription>
                </Alert>
              )}

              <div className="space-y-2">
                <Label htmlFor="password">Password</Label>
                <Input
                  id="password"
                  name="password"
                  type="password"
                  autoComplete="current-password"
                  required
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  placeholder="Enter your password"
                />
              </div>

              <Button type="submit" className="w-full" disabled={loginMutation.isPending}>
                {loginMutation.isPending ? (
                  <span className="flex items-center gap-2">
                    <Spinner size="sm" className="text-primary-foreground" />
                    Signing in...
                  </span>
                ) : (
                  'Sign in'
                )}
              </Button>
            </form>
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
