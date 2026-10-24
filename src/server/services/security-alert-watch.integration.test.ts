import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import { setupTestDb, teardownTestDb, testPrisma, clearTestDb } from '@/test/setup-test-db';
import type { AlertClosure, SecurityAlert, SecurityAlertKind } from '@/lib/security-alerts';

vi.mock('./github', () => ({
  fetchOpenSecurityAlerts: vi.fn(),
  fetchSecurityAlert: vi.fn(),
}));

let watch: typeof import('./security-alert-watch');
let github: typeof import('./github');

/** What GitHub currently says, keyed by `kind:number`; tests edit it between polls. */
let remote: Map<string, { alert: SecurityAlert; closure: AlertClosure | null }>;
let unreadable: Set<SecurityAlertKind>;
const live = new Set<string>();
const dropping = new Set<string>();
const delivered: { sessionId: string; text: string }[] = [];

function remoteAlert(
  number: number,
  overrides: Partial<SecurityAlert> = {},
  closure: AlertClosure | null = null
) {
  const alert: SecurityAlert = {
    kind: 'dependabot',
    number,
    url: `https://github.com/o/r/security/dependabot/${number}`,
    createdAt: new Date().toISOString(),
    severity: 'high',
    subject: `Dependabot npm pkg-${number}`,
    title: `Advisory ${number}`,
    details: [],
    ...overrides,
  };
  remote.set(`${alert.kind}:${number}`, { alert, closure });
}

function close(number: number, closure: Partial<AlertClosure> = {}) {
  const entry = remote.get(`dependabot:${number}`)!;
  entry.closure = { state: 'dismissed', by: 'brendan', reason: null, comment: null, ...closure };
}

async function createSession() {
  const session = await testPrisma.session.create({
    data: { name: 'Triage', repoPath: '', status: 'running', agentName: 'triage-1' },
  });
  live.add(session.id);
  return session;
}

beforeAll(async () => {
  await setupTestDb();
  watch = await import('./security-alert-watch');
  github = await import('./github');
});

afterAll(async () => {
  watch._resetSecurityAlertWatchState();
  await teardownTestDb();
});

beforeEach(async () => {
  await clearTestDb();
  vi.clearAllMocks();
  live.clear();
  dropping.clear();
  delivered.length = 0;
  remote = new Map();
  unreadable = new Set();
  vi.mocked(github.fetchOpenSecurityAlerts).mockImplementation(async (_repo, kind) => {
    if (unreadable.has(kind)) throw new Error(`${kind} alerts are disabled`);
    return [...remote.values()]
      .filter((e) => e.alert.kind === kind && !e.closure)
      .map((e) => e.alert);
  });
  vi.mocked(github.fetchSecurityAlert).mockImplementation(
    async (_repo, kind, number) => remote.get(`${kind}:${number}`) ?? null
  );
  watch._resetSecurityAlertWatchState();
  watch.initSecurityAlertWatch({
    hasLiveQuery: (sessionId) => live.has(sessionId),
    deliverMessage: async (sessionId, text) => {
      if (dropping.has(sessionId)) return false;
      delivered.push({ sessionId, text });
      return true;
    },
  });
});

describe('setSecurityAlertWatches', () => {
  it('returns the open alerts without reporting them as news', async () => {
    remoteAlert(1);
    remoteAlert(2);
    close(2);
    const session = await createSession();

    const [repo] = await watch.setSecurityAlertWatches(session.id, ['O/R']);

    expect(repo.repoFullName).toBe('o/r');
    expect(repo.alerts.dependabot?.map((a) => a.number)).toEqual([1]);
    await watch._pollSecurityAlertWatches();
    expect(delivered).toEqual([]);
  });

  it('reports kinds it couldn’t read, and fails when it can read none', async () => {
    const session = await createSession();
    unreadable.add('code-scanning');
    const [repo] = await watch.setSecurityAlertWatches(session.id, ['o/r']);
    expect(repo.failures.map((f) => f.kind)).toEqual(['code-scanning']);

    unreadable.add('dependabot').add('secret-scanning');
    await expect(watch.setSecurityAlertWatches(session.id, ['o/other'])).rejects.toThrow(
      /disabled/
    );
    const rows = await testPrisma.securityAlertWatch.findMany();
    expect(rows.map((r) => r.repoFullName)).toEqual(['o/r']);
  });

  it('replaces the watched repos, and stop removes them all', async () => {
    const session = await createSession();
    await watch.setSecurityAlertWatches(session.id, ['o/a', 'o/b']);
    await watch.setSecurityAlertWatches(session.id, ['o/b', 'o/c']);
    const repos = async () =>
      (await testPrisma.securityAlertWatch.findMany({ orderBy: { repoFullName: 'asc' } })).map(
        (r) => r.repoFullName
      );
    expect(await repos()).toEqual(['o/b', 'o/c']);

    await watch.stopSecurityAlertWatches(session.id);
    expect(await repos()).toEqual([]);
  });
});

describe('polling', () => {
  it('delivers new, reopened and closed alerts once, in one message', async () => {
    remoteAlert(1);
    remoteAlert(2);
    remoteAlert(3);
    close(3);
    const session = await createSession();
    await watch.setSecurityAlertWatches(session.id, ['o/r']);

    remoteAlert(4);
    close(1, { reason: 'tolerable_risk', comment: 'dev only' });
    remote.get('dependabot:3')!.closure = null;
    await watch._pollSecurityAlertWatches();

    expect(delivered).toHaveLength(1);
    const { text } = delivered[0];
    expect(text).toMatch(/New:\n.*\n.*#4/);
    expect(text).toMatch(/Reopened:\n.*\n.*#3/);
    expect(text).toMatch(/#1 .*dismissed by brendan \(tolerable_risk\): "dev only"/);
    expect(text).not.toContain('#2');

    await watch._pollSecurityAlertWatches();
    expect(delivered).toHaveLength(1);
  });

  it('batches every repo a session watches into one message', async () => {
    const session = await createSession();
    await watch.setSecurityAlertWatches(session.id, ['o/a', 'o/b']);
    remoteAlert(1);
    await watch._pollSecurityAlertWatches();
    expect(delivered).toHaveLength(1);
    expect(delivered[0].text).toContain('o/a');
    expect(delivered[0].text).toContain('o/b');
  });

  it('keeps changes for a session that couldn’t be told until it can', async () => {
    const session = await createSession();
    await watch.setSecurityAlertWatches(session.id, ['o/r']);
    remoteAlert(1);

    live.delete(session.id);
    await watch._pollSecurityAlertWatches();
    dropping.add(session.id);
    live.add(session.id);
    await watch._pollSecurityAlertWatches();
    expect(delivered).toEqual([]);

    dropping.delete(session.id);
    await watch._pollSecurityAlertWatches();
    expect(delivered).toHaveLength(1);
    expect(delivered[0].text).toContain('#1');
  });

  it('doesn’t report a kind’s alerts as closed while it can’t be read', async () => {
    remoteAlert(1);
    const session = await createSession();
    await watch.setSecurityAlertWatches(session.id, ['o/r']);

    unreadable.add('dependabot');
    await watch._pollSecurityAlertWatches();
    expect(delivered).toEqual([]);

    unreadable.delete('dependabot');
    await watch._pollSecurityAlertWatches();
    expect(delivered).toEqual([]);
  });

  it('keeps an alert that left the open list but reads as open, and reports it once closed', async () => {
    remoteAlert(1);
    const session = await createSession();
    await watch.setSecurityAlertWatches(session.id, ['o/r']);

    vi.mocked(github.fetchOpenSecurityAlerts).mockResolvedValueOnce([]);
    await watch._pollSecurityAlertWatches();
    expect(delivered).toEqual([]);

    close(1, { state: 'fixed', by: null });
    await watch._pollSecurityAlertWatches();
    expect(delivered).toHaveLength(1);
    expect(delivered[0].text).toMatch(/#1 .*fixed/);
  });
});
