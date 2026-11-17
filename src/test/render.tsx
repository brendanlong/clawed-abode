import type { ReactElement, ReactNode } from 'react';
import { render as rtlRender, type RenderOptions } from '@testing-library/react';
import { TooltipProvider } from '@/components/ui/tooltip';

/**
 * Testing Library's `render`, inside the app-wide providers that `Providers.tsx`
 * mounts once for the whole app (tooltips need a `TooltipProvider` ancestor).
 * A `wrapper` passed in still applies, inside them.
 */
export function render(ui: ReactElement, options?: Omit<RenderOptions, 'queries'>) {
  const Inner = options?.wrapper;
  function Wrapper({ children }: { children: ReactNode }) {
    return <TooltipProvider>{Inner ? <Inner>{children}</Inner> : children}</TooltipProvider>;
  }
  return rtlRender(ui, { ...options, wrapper: Wrapper });
}
