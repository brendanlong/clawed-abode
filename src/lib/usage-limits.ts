import { z } from 'zod';

/**
 * Schemas and pure selection logic for claude.ai subscription usage limits
 * (issue #379). The data comes from claude.ai's internal
 * `/api/organizations/{orgId}/usage` endpoint; only the `limits` array is
 * consumed — the rest of the response is ignored.
 */

export const usageLimitScopeSchema = z.object({
  model: z
    .object({
      id: z.string().nullish(),
      display_name: z.string().nullish(),
    })
    .nullish(),
});

export const usageLimitSchema = z.object({
  kind: z.string(),
  group: z.string(),
  percent: z.number(),
  severity: z.string().nullish(),
  resets_at: z.string().nullish(),
  scope: usageLimitScopeSchema.nullish(),
  is_active: z.boolean().nullish(),
});

export const usageResponseSchema = z.object({
  limits: z.array(usageLimitSchema).default([]),
});

/** One org from claude.ai's `/api/organizations` (used for org auto-discovery). */
export const organizationSchema = z.object({
  uuid: z.string(),
  capabilities: z.array(z.string()).default([]),
});

export const organizationsResponseSchema = z.array(organizationSchema);

export type UsageLimit = z.infer<typeof usageLimitSchema>;
export type Organization = z.infer<typeof organizationSchema>;

/** One bar shown in the UI, already selected for the active model. */
export interface UsageLimitBar {
  key: 'session' | 'weekly';
  label: string;
  percent: number;
  severity: 'normal' | 'warning' | 'exceeded';
  resetsAt: string | null;
}

export const usageLimitBarSchema = z.object({
  key: z.enum(['session', 'weekly']),
  label: z.string(),
  percent: z.number(),
  severity: z.enum(['normal', 'warning', 'exceeded']),
  resetsAt: z.string().nullable(),
});

function normalizeSeverity(severity: string | null | undefined): UsageLimitBar['severity'] {
  if (severity === 'warning') return 'warning';
  // The API's severity vocabulary isn't documented; treat anything that isn't
  // normal/warning (e.g. "exceeded", "critical") as the most urgent bucket.
  if (severity && severity !== 'normal') return 'exceeded';
  return 'normal';
}

/**
 * Whether a scoped limit applies to the active model. The scope carries a
 * model `id` (often null) and a human `display_name` like "Fable"; the active
 * model is a Claude Code model string like "claude-fable-5" or an alias like
 * "opus". Match by substring in either direction, case-insensitively.
 */
export function scopeMatchesModel(scope: UsageLimit['scope'], activeModel: string | null): boolean {
  if (!scope?.model || !activeModel) return false;
  const model = activeModel.toLowerCase();
  const candidates = [scope.model.id, scope.model.display_name]
    .filter((value): value is string => typeof value === 'string' && value.length > 0)
    .map((value) => value.toLowerCase());
  return candidates.some((candidate) => model.includes(candidate) || candidate.includes(model));
}

function toBar(limit: UsageLimit, key: UsageLimitBar['key'], label: string): UsageLimitBar {
  return {
    key,
    label,
    percent: limit.percent,
    severity: normalizeSeverity(limit.severity),
    resetsAt: limit.resets_at ?? null,
  };
}

/**
 * Select the bars to display: the session limit, and the weekly limit — the
 * model-scoped weekly limit when one matches the active model, otherwise the
 * all-models weekly limit.
 */
export function selectUsageLimits(
  limits: UsageLimit[],
  activeModel: string | null
): UsageLimitBar[] {
  const bars: UsageLimitBar[] = [];

  const session = limits.find((limit) => limit.group === 'session');
  if (session) {
    bars.push(toBar(session, 'session', 'Session'));
  }

  const weekly = limits.filter((limit) => limit.group === 'weekly');
  const scoped = weekly.find(
    (limit) => limit.scope?.model && scopeMatchesModel(limit.scope, activeModel)
  );
  const allModels = weekly.find((limit) => !limit.scope?.model);
  const chosen = scoped ?? allModels;
  if (chosen) {
    const scopeName = scoped?.scope?.model?.display_name;
    bars.push(toBar(chosen, 'weekly', scopeName ? `Weekly (${scopeName})` : 'Weekly'));
  }

  return bars;
}
