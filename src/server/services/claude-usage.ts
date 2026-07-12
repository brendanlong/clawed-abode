import { prisma } from '@/lib/prisma';
import { decrypt } from '@/lib/crypto';
import { createLogger } from '@/lib/logger';
import {
  usageResponseSchema,
  organizationsResponseSchema,
  type UsageLimit,
} from '@/lib/usage-limits';

/**
 * Fetches subscription usage limits from claude.ai's internal
 * `/api/organizations/{orgId}/usage` endpoint (issue #379). There is no public
 * API for this; the endpoint authenticates with the user's claude.ai session
 * cookie, which is stored (encrypted) in GlobalSettings.
 */

const log = createLogger('claude-usage');

const CLAUDE_AI_API = 'https://claude.ai/api';

/** How long a fetched (or failed) usage response is served from cache. */
export const USAGE_CACHE_TTL_MS = 60_000;

// claude.ai sits behind Cloudflare, which is more likely to accept requests
// that look like a browser.
const BROWSER_HEADERS: Record<string, string> = {
  accept: 'application/json',
  'user-agent':
    'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
};

export interface UsageLimitsResult {
  /** Whether a claude.ai session cookie is configured at all. */
  configured: boolean;
  /** Parsed limits, or null when unconfigured or the fetch failed. */
  limits: UsageLimit[] | null;
  /** Human-readable failure reason (for the settings UI), null on success. */
  error: string | null;
}

/**
 * Build the Cookie header from the stored setting. Accepts either a bare
 * sessionKey value (`sk-ant-sid01-...`) or a full cookie string containing
 * `=` (e.g. copied from devtools as `sessionKey=sk-ant-sid01-...`).
 */
export function buildCookieHeader(stored: string): string {
  const trimmed = stored.trim();
  return trimmed.includes('=') ? trimmed : `sessionKey=${trimmed}`;
}

async function claudeAiFetch(
  path: string,
  cookieHeader: string,
  fetchFn: typeof fetch
): Promise<unknown> {
  const response = await fetchFn(`${CLAUDE_AI_API}${path}`, {
    headers: { ...BROWSER_HEADERS, cookie: cookieHeader },
  });
  if (!response.ok) {
    throw new Error(`claude.ai API returned ${response.status} for ${path}`);
  }
  return response.json();
}

/**
 * Discover the organization UUID by listing the account's organizations.
 * Prefers an org with the "chat" capability (the consumer claude.ai org).
 */
export async function discoverOrganizationId(
  cookieHeader: string,
  fetchFn: typeof fetch = fetch
): Promise<string> {
  const raw = await claudeAiFetch('/organizations', cookieHeader, fetchFn);
  const orgs = organizationsResponseSchema.parse(raw);
  if (orgs.length === 0) {
    throw new Error('claude.ai returned no organizations for this cookie');
  }
  const chatOrg = orgs.find((org) => org.capabilities.includes('chat'));
  return (chatOrg ?? orgs[0]).uuid;
}

/**
 * Fetch and parse usage limits for one org. Exported for tests; throws on any
 * HTTP or schema failure.
 */
export async function fetchUsageFromClaudeAi(
  cookieHeader: string,
  orgId: string,
  fetchFn: typeof fetch = fetch
): Promise<UsageLimit[]> {
  const raw = await claudeAiFetch(`/organizations/${orgId}/usage`, cookieHeader, fetchFn);
  return usageResponseSchema.parse(raw).limits;
}

// One cached result (single-user app). Keyed by the settings it was fetched
// with so a cookie/org change invalidates naturally; failures are cached too,
// so a bad cookie doesn't hammer claude.ai on every poll.
interface UsageCache {
  key: string;
  fetchedAt: number;
  result: UsageLimitsResult;
}

let usageCache: UsageCache | null = null;
// In-flight fetch, so concurrent cache misses (e.g. the session page and the
// settings page polling together) coalesce into one upstream request.
let inFlight: { key: string; promise: Promise<UsageLimitsResult> } | null = null;
// Discovered org id, keyed by the cookie it was discovered with. Kept until
// the cookie changes — org membership effectively never changes mid-session.
let discoveredOrg: { cookieKey: string; orgId: string } | null = null;

/** Reset all in-memory caches (settings mutations and tests). */
export function clearUsageCache(): void {
  usageCache = null;
  inFlight = null;
  discoveredOrg = null;
}

async function fetchAndCacheUsage(
  cookieCiphertext: string,
  storedOrgId: string | null,
  cacheKey: string,
  fetchFn: typeof fetch
): Promise<UsageLimitsResult> {
  let result: UsageLimitsResult;
  try {
    const cookieHeader = buildCookieHeader(decrypt(cookieCiphertext));
    let orgId = storedOrgId?.trim() || null;
    if (!orgId) {
      if (discoveredOrg?.cookieKey === cookieCiphertext) {
        orgId = discoveredOrg.orgId;
      } else {
        orgId = await discoverOrganizationId(cookieHeader, fetchFn);
        discoveredOrg = { cookieKey: cookieCiphertext, orgId };
        log.info('Discovered claude.ai organization for usage limits', { orgId });
      }
    }
    const limits = await fetchUsageFromClaudeAi(cookieHeader, orgId, fetchFn);
    result = { configured: true, limits, error: null };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    log.error('Failed to fetch claude.ai usage limits', err instanceof Error ? err : undefined);
    result = { configured: true, limits: null, error: message };
  }

  usageCache = { key: cacheKey, fetchedAt: Date.now(), result };
  return result;
}

/**
 * Get the current usage limits, cached for {@link USAGE_CACHE_TTL_MS}.
 * Never throws: failures are logged and reported via `error`.
 */
export async function getUsageLimits(fetchFn: typeof fetch = fetch): Promise<UsageLimitsResult> {
  const settings = await prisma.globalSettings.findUnique({
    where: { id: 'global' },
    select: { claudeAiSessionCookie: true, claudeAiOrgId: true },
  });

  if (!settings?.claudeAiSessionCookie) {
    return { configured: false, limits: null, error: null };
  }

  const cacheKey = `${settings.claudeAiSessionCookie}|${settings.claudeAiOrgId ?? ''}`;
  if (
    usageCache &&
    usageCache.key === cacheKey &&
    Date.now() - usageCache.fetchedAt < USAGE_CACHE_TTL_MS
  ) {
    return usageCache.result;
  }

  if (inFlight?.key === cacheKey) {
    return inFlight.promise;
  }

  const promise = fetchAndCacheUsage(
    settings.claudeAiSessionCookie,
    settings.claudeAiOrgId,
    cacheKey,
    fetchFn
  );
  inFlight = { key: cacheKey, promise };
  try {
    return await promise;
  } finally {
    inFlight = null;
  }
}
