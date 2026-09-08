/**
 * The origin the user's browser reaches this app on. OAuth redirect URIs must
 * be reachable from the browser, so loopback is useless here — the app runs
 * headless behind Tailscale Serve and the user is on another device.
 */

export interface OriginHeaders {
  forwardedProto?: string | null;
  forwardedHost?: string | null;
  host?: string | null;
}

export function originHeadersFrom(headers: Headers): OriginHeaders {
  return {
    forwardedProto: headers.get('x-forwarded-proto'),
    forwardedHost: headers.get('x-forwarded-host'),
    host: headers.get('host'),
  };
}

/**
 * `APP_URL` when the operator set one, else the proxy's forwarded host/proto.
 * Returns null when neither is available, which callers surface as a
 * configuration error rather than guessing a URL an OAuth server would reject.
 */
export function resolveAppOrigin(
  appUrl: string | undefined,
  headers: OriginHeaders
): string | null {
  if (appUrl?.trim()) {
    try {
      return new URL(appUrl.trim()).origin;
    } catch {
      return null;
    }
  }

  // Proxies may chain values; the first entry is the one the client saw.
  const host = firstValue(headers.forwardedHost) ?? firstValue(headers.host);
  if (!host) return null;
  const proto = firstValue(headers.forwardedProto) ?? defaultProtoFor(host);
  try {
    return new URL(`${proto}://${host}`).origin;
  } catch {
    return null;
  }
}

function firstValue(value: string | null | undefined): string | undefined {
  return value?.split(',')[0]?.trim() || undefined;
}

function defaultProtoFor(host: string): string {
  const hostname = host.split(':')[0];
  return hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '[::1]'
    ? 'http'
    : 'https';
}
