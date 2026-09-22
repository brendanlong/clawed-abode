/**
 * Runs under the unit project, which is `environment: 'node'` — i.e. no DOM,
 * the same conditions as SSR. Importing dompurify's no-DOM stub and calling
 * `addHook` on it at module scope 500'd every session page load once already.
 */
import { describe, it, expect } from 'vitest';
import { sanitizeHtml } from './sanitize-html';

describe('sanitizeHtml without a DOM', () => {
  it('imports without throwing', async () => {
    await expect(import('./sanitize-html')).resolves.toBeDefined();
  });

  it('yields nothing rather than throwing', () => {
    expect(sanitizeHtml('<p>hello</p>')).toBe('');
  });

  it('is reachable through the modules that render sanitized HTML', async () => {
    await expect(import('./terminal-output')).resolves.toBeDefined();
    await expect(import('@/components/MarkdownContent')).resolves.toBeDefined();
  });
});
