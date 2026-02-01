import { clsx, type ClassValue } from 'clsx';
import { twMerge } from 'tailwind-merge';

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

/**
 * Extract the full repo name (owner/repo) from a GitHub URL.
 * Handles URLs like:
 * - https://github.com/owner/repo
 * - https://github.com/owner/repo.git
 */
export function extractRepoFullName(repoUrl: string): string {
  return repoUrl.replace('https://github.com/', '').replace('.git', '');
}
