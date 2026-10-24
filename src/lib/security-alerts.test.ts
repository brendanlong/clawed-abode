import { describe, it, expect } from 'vitest';
import {
  diffSnapshots,
  formatAlertChanges,
  formatAlertList,
  mergeSnapshot,
  parseSnapshot,
  securityAlertSchemas,
  type AlertSnapshot,
  type SecurityAlert,
} from './security-alerts';

function alert(overrides: Partial<SecurityAlert> = {}): SecurityAlert {
  return {
    kind: 'dependabot',
    number: 1,
    url: 'https://github.com/o/r/security/dependabot/1',
    createdAt: '2026-01-01T00:00:00Z',
    severity: 'high',
    subject: 'Dependabot npm next',
    title: 'Middleware bypass (GHSA-1)',
    details: [],
    ...overrides,
  };
}

const dependabotPayload = {
  number: 41,
  state: 'open',
  html_url: 'https://github.com/o/r/security/dependabot/41',
  created_at: '2026-01-02T00:00:00Z',
  dependency: {
    package: { ecosystem: 'npm', name: 'next' },
    manifest_path: 'package-lock.json',
    scope: 'runtime',
    relationship: 'transitive',
  },
  security_advisory: {
    ghsa_id: 'GHSA-aaaa',
    cve_id: 'CVE-2026-1',
    summary: 'Middleware bypass',
    severity: 'critical',
  },
  security_vulnerability: {
    vulnerable_version_range: '< 15.2.3',
    first_patched_version: { identifier: '15.2.3' },
  },
  dismissed_by: null,
  dismissed_reason: null,
  dismissed_comment: null,
};

describe('securityAlertSchemas', () => {
  it('describes a Dependabot alert by package, scope, relationship and patched version', () => {
    const { alert: parsed, closure } = securityAlertSchemas.dependabot.parse(dependabotPayload);
    expect(closure).toBeNull();
    expect(parsed).toMatchObject({ kind: 'dependabot', number: 41, severity: 'critical' });
    expect(parsed.subject).toContain('next');
    expect(parsed.title).toContain('GHSA-aaaa');
    const details = parsed.details.join(' ');
    for (const part of ['package-lock.json', 'runtime', 'transitive', '15.2.3']) {
      expect(details).toContain(part);
    }
  });

  it('reads who dismissed an alert and why', () => {
    const { closure } = securityAlertSchemas.dependabot.parse({
      ...dependabotPayload,
      state: 'dismissed',
      dismissed_by: { login: 'brendan' },
      dismissed_reason: 'tolerable_risk',
      dismissed_comment: 'Dev only',
    });
    expect(closure).toEqual({
      state: 'dismissed',
      by: 'brendan',
      reason: 'tolerable_risk',
      comment: 'Dev only',
    });
  });

  it('accepts a code scanning rule without a description', () => {
    const { alert: parsed } = securityAlertSchemas['code-scanning'].parse({
      number: 4,
      state: 'open',
      html_url: 'https://github.com/o/r/security/code-scanning/4',
      created_at: '2026-01-02T00:00:00Z',
      rule: { id: 'custom/rule', severity: 'warning' },
      tool: { name: 'Semgrep' },
      most_recent_instance: null,
    });
    expect(parsed.title).toContain('custom/rule');
  });

  it('prefers a code scanning rule’s security severity and gives the location', () => {
    const { alert: parsed } = securityAlertSchemas['code-scanning'].parse({
      number: 3,
      state: 'open',
      html_url: 'https://github.com/o/r/security/code-scanning/3',
      created_at: '2026-01-02T00:00:00Z',
      rule: {
        id: 'js/sql-injection',
        severity: 'error',
        security_severity_level: 'high',
        description: 'SQL injection',
      },
      tool: { name: 'CodeQL' },
      most_recent_instance: { location: { path: 'src/db.ts', start_line: 12 } },
    });
    expect(parsed.severity).toBe('high');
    expect(parsed.subject).toContain('js/sql-injection');
    expect(parsed.details).toContain('src/db.ts:12');
  });

  it('never carries a leaked secret’s value', () => {
    const parsed = securityAlertSchemas['secret-scanning'].parse({
      number: 7,
      state: 'resolved',
      html_url: 'https://github.com/o/r/security/secret-scanning/7',
      created_at: '2026-01-02T00:00:00Z',
      secret_type: 'github_personal_access_token',
      secret_type_display_name: 'GitHub Personal Access Token',
      secret: 'ghp_supersecret',
      validity: 'active',
      resolution: 'revoked',
      resolved_by: { login: 'brendan' },
    });
    expect(JSON.stringify(parsed)).not.toContain('ghp_supersecret');
    expect(parsed.closure).toMatchObject({ state: 'resolved', by: 'brendan', reason: 'revoked' });
  });
});

describe('parseSnapshot', () => {
  it('round-trips a snapshot and reads garbage as never read', () => {
    const snapshot: AlertSnapshot = {
      dependabot: { checkedAt: '2026-01-01T00:00:00.000Z', alerts: [alert()] },
      'secret-scanning': {
        checkedAt: '2026-01-01T00:00:00.000Z',
        alerts: [alert({ number: 2, kind: 'secret-scanning', severity: null })],
      },
    };
    expect(parseSnapshot(JSON.stringify(snapshot))).toEqual(snapshot);
    expect(parseSnapshot('not json')).toEqual({});
    expect(parseSnapshot('{"dependabot":{"alerts":[{"kind":"nope"}]}}')).toEqual({});
  });
});

describe('mergeSnapshot', () => {
  it('replaces the kinds that were read and keeps the last read of the rest', () => {
    const code = {
      checkedAt: '2026-01-01T00:00:00.000Z',
      alerts: [alert({ kind: 'code-scanning' })],
    };
    const fresh = alert({ number: 2 });
    const checkedAt = new Date('2026-02-01T00:00:00Z');
    expect(
      mergeSnapshot(
        { dependabot: { checkedAt: code.checkedAt, alerts: [alert()] }, 'code-scanning': code },
        { dependabot: [fresh] },
        checkedAt
      )
    ).toEqual({
      dependabot: { checkedAt: checkedAt.toISOString(), alerts: [fresh] },
      'code-scanning': code,
    });
  });
});

describe('diffSnapshots', () => {
  const checkedAt = '2026-02-01T00:00:00.000Z';
  const later = '2026-03-01T00:00:00.000Z';

  it('separates new alerts from reopened ones by whether they predate their kind’s last read', () => {
    const kept = alert({ number: 1 });
    const gone = alert({ number: 2 });
    const brandNew = alert({ number: 3, createdAt: '2026-02-02T00:00:00Z' });
    const reopened = alert({ number: 4, createdAt: '2026-01-15T00:00:00Z' });
    expect(
      diffSnapshots(
        { dependabot: { checkedAt, alerts: [kept, gone] } },
        { dependabot: { checkedAt: later, alerts: [kept, brandNew, reopened] } }
      )
    ).toEqual({ opened: [brandNew], reopened: [reopened], nowReadable: [], left: [gone] });
  });

  it('counts an alert created in the same second as the last read as new', () => {
    const sameSecond = alert({ number: 5, createdAt: '2026-02-01T00:00:00Z' });
    expect(
      diffSnapshots(
        { dependabot: { checkedAt: '2026-02-01T00:00:00.400Z', alerts: [] } },
        { dependabot: { checkedAt: later, alerts: [sameSecond] } }
      ).opened
    ).toEqual([sameSecond]);
  });

  it('reports a kind read for the first time as now readable, not reopened', () => {
    const old = alert({ kind: 'code-scanning', createdAt: '2025-01-01T00:00:00Z' });
    expect(
      diffSnapshots(
        { dependabot: { checkedAt, alerts: [] } },
        {
          dependabot: { checkedAt: later, alerts: [] },
          'code-scanning': { checkedAt: later, alerts: [old] },
        }
      )
    ).toEqual({ opened: [], reopened: [], nowReadable: [old], left: [] });
  });

  it('tells alerts of different kinds with the same number apart', () => {
    const dependabot = alert({ number: 1 });
    const code = alert({ kind: 'code-scanning', number: 1, createdAt: later });
    expect(
      diffSnapshots(
        {
          dependabot: { checkedAt, alerts: [dependabot] },
          'code-scanning': { checkedAt, alerts: [] },
        },
        {
          dependabot: { checkedAt: later, alerts: [] },
          'code-scanning': { checkedAt: later, alerts: [code] },
        }
      )
    ).toEqual({ opened: [code], reopened: [], nowReadable: [], left: [dependabot] });
  });
});

describe('formatting', () => {
  it('groups alerts by subject, most severe group first', () => {
    const text = formatAlertList([
      alert({ number: 1, subject: 'Dependabot npm lodash', severity: 'low' }),
      alert({ number: 2, subject: 'Dependabot npm next', severity: 'medium' }),
      alert({ number: 3, subject: 'Dependabot npm next', severity: 'critical' }),
    ]);
    expect(text.indexOf('next')).toBeLessThan(text.indexOf('lodash'));
    expect(text.indexOf('#3')).toBeLessThan(text.indexOf('#2'));
    expect(text.match(/Dependabot npm next/g)).toHaveLength(1);
  });

  it('lists each repo’s changes with how closed alerts were closed, skipping repos without any', () => {
    const text = formatAlertChanges([
      {
        repoFullName: 'o/r',
        opened: [alert({ number: 1 })],
        reopened: [],
        nowReadable: [],
        closed: [
          {
            alert: alert({ number: 2 }),
            closure: { state: 'dismissed', by: 'brendan', reason: 'tolerable_risk', comment: 'ok' },
          },
        ],
      },
      { repoFullName: 'o/quiet', opened: [], reopened: [], nowReadable: [], closed: [] },
    ]);
    expect(text).toContain('o/r');
    expect(text).not.toContain('o/quiet');
    expect(text).toMatch(/#2 .*dismissed by brendan \(tolerable_risk\): "ok"/);
  });
});
