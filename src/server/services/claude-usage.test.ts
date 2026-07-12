import { describe, it, expect, vi } from 'vitest';
import { buildCookieHeader, discoverOrganizationId, fetchUsageFromClaudeAi } from './claude-usage';

function fakeFetch(routes: Record<string, { status?: number; body: unknown }>): typeof fetch {
  return vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input);
    const match = Object.entries(routes).find(([path]) => url.endsWith(path));
    if (!match) {
      return new Response('not found', { status: 404 });
    }
    const { status = 200, body } = match[1];
    return new Response(JSON.stringify(body), {
      status,
      headers: { 'content-type': 'application/json' },
    });
  }) as unknown as typeof fetch;
}

describe('buildCookieHeader', () => {
  it('wraps a bare sessionKey value', () => {
    expect(buildCookieHeader('sk-ant-sid01-abc')).toBe('sessionKey=sk-ant-sid01-abc');
  });

  it('passes through a full cookie string', () => {
    expect(buildCookieHeader('sessionKey=sk-ant-sid01-abc; other=1')).toBe(
      'sessionKey=sk-ant-sid01-abc; other=1'
    );
  });

  it('trims whitespace', () => {
    expect(buildCookieHeader('  sk-ant-sid01-abc\n')).toBe('sessionKey=sk-ant-sid01-abc');
  });
});

describe('discoverOrganizationId', () => {
  it('prefers the org with the chat capability', async () => {
    const fetchFn = fakeFetch({
      '/organizations': {
        body: [
          { uuid: 'api-org', capabilities: ['api'] },
          { uuid: 'chat-org', capabilities: ['chat', 'claude_pro'] },
        ],
      },
    });
    expect(await discoverOrganizationId('sessionKey=x', fetchFn)).toBe('chat-org');
  });

  it('falls back to the first org when none has chat', async () => {
    const fetchFn = fakeFetch({
      '/organizations': { body: [{ uuid: 'only-org' }] },
    });
    expect(await discoverOrganizationId('sessionKey=x', fetchFn)).toBe('only-org');
  });

  it('throws on an empty org list', async () => {
    const fetchFn = fakeFetch({ '/organizations': { body: [] } });
    await expect(discoverOrganizationId('sessionKey=x', fetchFn)).rejects.toThrow(
      'no organizations'
    );
  });

  it('throws on an auth failure', async () => {
    const fetchFn = fakeFetch({ '/organizations': { status: 403, body: {} } });
    await expect(discoverOrganizationId('sessionKey=x', fetchFn)).rejects.toThrow('403');
  });
});

describe('fetchUsageFromClaudeAi', () => {
  it('fetches and parses the limits array, sending the cookie', async () => {
    const fetchFn = fakeFetch({
      '/organizations/org-1/usage': {
        body: {
          limits: [
            { kind: 'session', group: 'session', percent: 58, severity: 'normal' },
            {
              kind: 'weekly_scoped',
              group: 'weekly',
              percent: 86,
              severity: 'warning',
              scope: { model: { id: null, display_name: 'Fable' } },
            },
          ],
        },
      },
    });

    const limits = await fetchUsageFromClaudeAi('sessionKey=secret', 'org-1', fetchFn);
    expect(limits).toHaveLength(2);
    expect(limits[1].scope?.model?.display_name).toBe('Fable');

    const [, init] = vi.mocked(fetchFn).mock.calls[0] as [string, RequestInit];
    expect((init.headers as Record<string, string>).cookie).toBe('sessionKey=secret');
  });

  it('throws on a malformed response', async () => {
    const fetchFn = fakeFetch({
      '/organizations/org-1/usage': { body: { limits: [{ kind: 'session' }] } },
    });
    await expect(fetchUsageFromClaudeAi('sessionKey=x', 'org-1', fetchFn)).rejects.toThrow();
  });
});
