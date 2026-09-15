import DOMPurify from 'dompurify';

/**
 * The one DOMPurify entry point. Everything that renders HTML through
 * `dangerouslySetInnerHTML` goes through here, so the anchor hook below applies
 * uniformly and the no-DOM case is handled in one place.
 *
 * Without a DOM, dompurify's default export is a stub carrying neither
 * `addHook` nor `sanitize`. These modules are imported during SSR, so touching
 * either at module scope or at render time throws and takes the page down with
 * a 500. Nothing renders sanitized HTML server-side today — the session page's
 * SSR pass stops at its loading state — but that is a property of the callers,
 * not something this module should rely on.
 */

// Open links in a new window. A sanitizer hook rather than a marked renderer
// override, because a renderer has to assemble the anchor as an HTML string —
// which means hand-escaping href/title and skipping marked's own URL
// sanitization. See doc/security.md. It only touches anchors, and `noopener` is
// wanted wherever one shows up.
if (DOMPurify.isSupported) {
  DOMPurify.addHook('afterSanitizeAttributes', (node) => {
    if (node.tagName === 'A' && node.hasAttribute('href')) {
      node.setAttribute('target', '_blank');
      node.setAttribute('rel', 'noopener noreferrer');
    }
  });
}

/** Sanitize HTML for `dangerouslySetInnerHTML`. Yields nothing without a DOM. */
export function sanitizeHtml(html: string): string {
  if (!DOMPurify.isSupported) return '';
  return DOMPurify.sanitize(html);
}
