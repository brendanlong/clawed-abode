/**
 * Escape a value for interpolation into a double- or single-quoted HTML
 * attribute. `&` is deliberately left alone: it cannot break out of an
 * attribute, and escaping it would double-encode the entity references that
 * markdown link destinations carry through verbatim (`?a=1&amp;b=2`).
 */
export function escapeHtmlAttribute(value: string): string {
  return value
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/** Escape a value for interpolation into HTML as literal text. */
export function escapeHtml(value: string): string {
  return escapeHtmlAttribute(value.replace(/&/g, '&amp;'));
}
