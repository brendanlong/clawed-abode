'use client';

import { Suspense } from 'react';
import { useSearchParams } from 'next/navigation';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Check, X } from 'lucide-react';

/**
 * Reports the outcome of an MCP OAuth authorization, which the browser carries
 * back as query parameters from `/api/mcp/oauth/callback` (the flow is a full
 * navigation, so there is no in-page state to return to).
 */
export function McpOAuthResultBanner() {
  return (
    <Suspense fallback={null}>
      <ResultBanner />
    </Suspense>
  );
}

function ResultBanner() {
  const params = useSearchParams();
  const connected = params.get('mcpConnected');
  const error = params.get('mcpAuthError');
  if (!connected && !error) return null;

  return (
    <Alert variant={error ? 'destructive' : 'default'} className="mb-6">
      {error ? <X className="h-4 w-4" /> : <Check className="h-4 w-4" />}
      <AlertTitle>{error ? 'MCP authorization failed' : `Connected ${connected}`}</AlertTitle>
      <AlertDescription>{error ?? 'The server can now be used in your sessions.'}</AlertDescription>
    </Alert>
  );
}
