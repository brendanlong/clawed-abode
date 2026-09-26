'use client';

import Image from 'next/image';
import { useTheme } from '@/lib/theme-context';

function getLogoSrc(isWorking: boolean, isDark: boolean): string {
  if (isWorking) {
    return isDark ? '/favicon-working-dark.svg' : '/favicon-working.svg';
  }
  return isDark ? '/favicon-dark.svg' : '/favicon.svg';
}

/**
 * Logo component that displays the Clawed Abode logo.
 * Shows an animated version when isWorking is true.
 * Uses the dark variant in dark mode.
 */
export function Logo({ isWorking }: { isWorking: boolean }) {
  const { theme } = useTheme();
  const src = getLogoSrc(isWorking, theme === 'dark');

  return (
    <Image
      src={src}
      alt={isWorking ? 'Clawed Abode logo (working)' : 'Clawed Abode logo'}
      width={28}
      height={28}
      className="shrink-0"
      priority
    />
  );
}
