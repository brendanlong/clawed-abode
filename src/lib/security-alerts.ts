/** Pure parts of security alert watches (src/server/services/security-alert-watch.ts). */

import { z } from 'zod';

/** Also the alerts' API path segment: `/repos/{repo}/{kind}/alerts`. */
export const SECURITY_ALERT_KINDS = ['dependabot', 'code-scanning', 'secret-scanning'] as const;
export type SecurityAlertKind = (typeof SECURITY_ALERT_KINDS)[number];

export interface SecurityAlert {
  kind: SecurityAlertKind;
  number: number;
  url: string;
  createdAt: string;
  severity: string | null;
  /** What alerts are grouped by: the package, rule or secret type. */
  subject: string;
  title: string;
  /** Where and how it applies: manifest, scope, patched version, or code location. */
  details: string[];
}

/** How an alert stopped being open. */
export interface AlertClosure {
  state: string;
  by: string | null;
  reason: string | null;
  comment: string | null;
}

/** An alert as GitHub reports it now: `closure` is null while it's open. */
export interface ParsedAlert {
  alert: SecurityAlert;
  closure: AlertClosure | null;
}

const userSchema = z.object({ login: z.string() }).nullish();

const alertFields = {
  number: z.number(),
  state: z.string(),
  html_url: z.string(),
  created_at: z.string(),
};

function closure(
  state: string,
  by: { login: string } | null | undefined,
  reason: string | null | undefined,
  comment: string | null | undefined
): AlertClosure | null {
  if (state === 'open') return null;
  return { state, by: by?.login ?? null, reason: reason ?? null, comment: comment || null };
}

const dependabotAlertSchema = z
  .object({
    ...alertFields,
    dependency: z.object({
      package: z.object({ ecosystem: z.string(), name: z.string() }),
      manifest_path: z.string(),
      scope: z.string().nullish(),
      relationship: z.string().nullish(),
    }),
    security_advisory: z.object({
      ghsa_id: z.string(),
      cve_id: z.string().nullish(),
      summary: z.string(),
      severity: z.string(),
    }),
    security_vulnerability: z.object({
      vulnerable_version_range: z.string(),
      first_patched_version: z.object({ identifier: z.string() }).nullish(),
    }),
    dismissed_by: userSchema,
    dismissed_reason: z.string().nullish(),
    dismissed_comment: z.string().nullish(),
  })
  .transform((a): ParsedAlert => {
    const { dependency: dep, security_advisory: advisory } = a;
    const patched = a.security_vulnerability.first_patched_version?.identifier;
    return {
      alert: {
        kind: 'dependabot',
        number: a.number,
        url: a.html_url,
        createdAt: a.created_at,
        severity: advisory.severity,
        subject: `Dependabot ${dep.package.ecosystem} ${dep.package.name}`,
        title: `${advisory.summary} (${[advisory.ghsa_id, advisory.cve_id].filter(Boolean).join(', ')})`,
        details: [
          dep.manifest_path,
          `${dep.scope ?? 'unknown'} scope`,
          ...(dep.relationship ? [dep.relationship] : []),
          `vulnerable ${a.security_vulnerability.vulnerable_version_range}`,
          patched ? `patched in ${patched}` : 'no patched version',
        ],
      },
      closure: closure(a.state, a.dismissed_by, a.dismissed_reason, a.dismissed_comment),
    };
  });

const codeScanningAlertSchema = z
  .object({
    ...alertFields,
    rule: z.object({
      id: z.string().nullish(),
      name: z.string().nullish(),
      severity: z.string().nullish(),
      security_severity_level: z.string().nullish(),
      description: z.string(),
    }),
    tool: z.object({ name: z.string().nullish() }),
    most_recent_instance: z
      .object({
        location: z
          .object({ path: z.string().nullish(), start_line: z.number().nullish() })
          .nullish(),
      })
      .nullish(),
    dismissed_by: userSchema,
    dismissed_reason: z.string().nullish(),
    dismissed_comment: z.string().nullish(),
  })
  .transform((a): ParsedAlert => {
    const location = a.most_recent_instance?.location;
    return {
      alert: {
        kind: 'code-scanning',
        number: a.number,
        url: a.html_url,
        createdAt: a.created_at,
        severity: a.rule.security_severity_level ?? a.rule.severity ?? null,
        subject: `${a.tool.name ?? 'Code scanning'} ${a.rule.id ?? a.rule.name ?? 'unknown rule'}`,
        title: a.rule.description,
        details: location?.path
          ? [location.start_line ? `${location.path}:${location.start_line}` : location.path]
          : [],
      },
      closure: closure(a.state, a.dismissed_by, a.dismissed_reason, a.dismissed_comment),
    };
  });

/** The secret itself is in the API response; it is deliberately not parsed. */
const secretScanningAlertSchema = z
  .object({
    ...alertFields,
    secret_type: z.string(),
    secret_type_display_name: z.string().nullish(),
    validity: z.string().nullish(),
    publicly_leaked: z.boolean().nullish(),
    push_protection_bypassed: z.boolean().nullish(),
    resolution: z.string().nullish(),
    resolved_by: userSchema,
    resolution_comment: z.string().nullish(),
  })
  .transform((a): ParsedAlert => {
    const name = a.secret_type_display_name ?? a.secret_type;
    return {
      alert: {
        kind: 'secret-scanning',
        number: a.number,
        url: a.html_url,
        createdAt: a.created_at,
        severity: null,
        subject: `Secret ${name}`,
        title: `${name} committed`,
        details: [
          `validity ${a.validity ?? 'unknown'}`,
          ...(a.publicly_leaked ? ['publicly leaked'] : []),
          ...(a.push_protection_bypassed ? ['push protection bypassed'] : []),
        ],
      },
      closure: closure(a.state, a.resolved_by, a.resolution, a.resolution_comment),
    };
  });

export const securityAlertSchemas: Record<SecurityAlertKind, z.ZodType<ParsedAlert>> = {
  dependabot: dependabotAlertSchema,
  'code-scanning': codeScanningAlertSchema,
  'secret-scanning': secretScanningAlertSchema,
};

const storedAlertsSchema = z.array(
  z.object({
    kind: z.enum(SECURITY_ALERT_KINDS),
    number: z.number(),
    url: z.string(),
    createdAt: z.string(),
    severity: z.string().nullable(),
    subject: z.string(),
    title: z.string(),
    details: z.array(z.string()),
  })
);

/** Decode `SecurityAlertWatch.openAlerts`; a bad value reads as empty, so its alerts are reported again. */
export function parseStoredAlerts(json: string): SecurityAlert[] {
  try {
    const parsed = storedAlertsSchema.safeParse(JSON.parse(json));
    return parsed.success ? parsed.data : [];
  } catch {
    return [];
  }
}

export function alertKey(alert: Pick<SecurityAlert, 'kind' | 'number'>): string {
  return `${alert.kind}:${alert.number}`;
}

/**
 * The open alerts as of now: what was read for each kind, and the previous
 * alerts of any kind that couldn't be read, so an unreadable kind never looks
 * like every alert of that kind was closed.
 */
export function currentAlerts(
  previous: SecurityAlert[],
  read: Partial<Record<SecurityAlertKind, SecurityAlert[]>>
): SecurityAlert[] {
  return SECURITY_ALERT_KINDS.flatMap(
    (kind) => read[kind] ?? previous.filter((alert) => alert.kind === kind)
  );
}

/**
 * What changed between two reads. An alert not in `previous` was opened since,
 * or reopened if it was created before the previous read. `left` are no longer
 * open; how they closed has to be looked up.
 */
export function diffAlerts(
  previous: SecurityAlert[],
  current: SecurityAlert[],
  previousCheckedAt: Date
): { opened: SecurityAlert[]; reopened: SecurityAlert[]; left: SecurityAlert[] } {
  const previousKeys = new Set(previous.map(alertKey));
  const currentKeys = new Set(current.map(alertKey));
  const appeared = current.filter((alert) => !previousKeys.has(alertKey(alert)));
  const isOld = (alert: SecurityAlert) => Date.parse(alert.createdAt) < previousCheckedAt.getTime();
  return {
    opened: appeared.filter((alert) => !isOld(alert)),
    reopened: appeared.filter(isOld),
    left: previous.filter((alert) => !currentKeys.has(alertKey(alert))),
  };
}

const SEVERITY_ORDER = [
  'critical',
  'high',
  'medium',
  'moderate',
  'error',
  'low',
  'warning',
  'note',
];

function severityRank(severity: string | null): number {
  // Secret alerts have no severity and are always urgent.
  if (severity === null) return -1;
  const rank = SEVERITY_ORDER.indexOf(severity);
  return rank === -1 ? SEVERITY_ORDER.length : rank;
}

function formatAlert(alert: SecurityAlert, suffix = ''): string {
  const severity = alert.severity ? `${alert.severity}: ` : '';
  const details = alert.details.length > 0 ? ` [${alert.details.join('; ')}]` : '';
  return `  - #${alert.number} ${severity}${alert.title}${details}${suffix} ${alert.url}`;
}

function formatClosure(c: AlertClosure): string {
  const by = c.by ? ` by ${c.by}` : '';
  const reason = c.reason ? ` (${c.reason})` : '';
  const comment = c.comment ? `: "${c.comment}"` : '';
  return ` — ${c.state}${by}${reason}${comment}`;
}

/** Alerts grouped by subject, most severe group first. */
function formatGroups<T>(
  items: T[],
  alertOf: (item: T) => SecurityAlert,
  line: (item: T) => string
) {
  const groups = new Map<string, T[]>();
  for (const item of items) {
    const subject = alertOf(item).subject;
    groups.set(subject, [...(groups.get(subject) ?? []), item]);
  }
  const worst = (group: T[]) => Math.min(...group.map((i) => severityRank(alertOf(i).severity)));
  return [...groups]
    .map(([subject, group]) => {
      const sorted = [...group].sort(
        (a, b) => severityRank(alertOf(a).severity) - severityRank(alertOf(b).severity)
      );
      return { subject, sorted, rank: worst(group) };
    })
    .sort((a, b) => a.rank - b.rank || a.subject.localeCompare(b.subject))
    .map(({ subject, sorted }) => [`- ${subject}`, ...sorted.map(line)].join('\n'))
    .join('\n');
}

export function formatAlertList(alerts: SecurityAlert[]): string {
  if (alerts.length === 0) return '(none)';
  return formatGroups(
    alerts,
    (a) => a,
    (a) => formatAlert(a)
  );
}

export interface RepoAlertChanges {
  repoFullName: string;
  opened: SecurityAlert[];
  reopened: SecurityAlert[];
  closed: { alert: SecurityAlert; closure: AlertClosure }[];
}

export function hasAlertChanges(changes: RepoAlertChanges): boolean {
  return changes.opened.length + changes.reopened.length + changes.closed.length > 0;
}

/** One message for everything a poll found, across the session's repos. */
export function formatAlertChanges(repos: RepoAlertChanges[]): string {
  const sections = repos.filter(hasAlertChanges).map((repo) => {
    const parts = [`## ${repo.repoFullName}`];
    if (repo.opened.length > 0) parts.push(`New:\n${formatAlertList(repo.opened)}`);
    if (repo.reopened.length > 0) parts.push(`Reopened:\n${formatAlertList(repo.reopened)}`);
    if (repo.closed.length > 0) {
      const closed = formatGroups(
        repo.closed,
        (c) => c.alert,
        (c) => formatAlert(c.alert, formatClosure(c.closure))
      );
      parts.push(`No longer open:\n${closed}`);
    }
    return parts.join('\n');
  });
  return `Security alert changes from watch_security_alerts:\n\n${sections.join('\n\n')}`;
}
