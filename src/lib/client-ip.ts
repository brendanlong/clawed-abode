/**
 * Tailscale Serve/Funnel and other reverse proxies put the real client IP first
 * in X-Forwarded-For. Takes a header getter so both Fetch `Headers` and Node's
 * `IncomingMessage` headers can use it.
 */
export function getClientIp(
  header: (name: string) => string | null | undefined
): string | undefined {
  const first = header('x-forwarded-for')?.split(',')[0]?.trim();
  return first || header('x-real-ip')?.trim() || undefined;
}
