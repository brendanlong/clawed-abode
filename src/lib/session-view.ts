import { parsePullRequestJson, type PullRequestInfo } from './pull-request';

/**
 * The shape of a session as the API returns it: the DB row with the JSON
 * `pullRequest` column decoded and `prCheckedAt` dropped (it only feeds the
 * server's own staleness check). Every router/SSE path that hands a session to
 * the client goes through {@link toSessionView} so the two can't drift.
 */
export type SessionView<Row extends { pullRequest: string | null }> = Omit<
  Row,
  'pullRequest' | 'prCheckedAt'
> & {
  pullRequest: PullRequestInfo | null;
};

export function toSessionView<Row extends { pullRequest: string | null }>(
  row: Row
): SessionView<Row> {
  const { prCheckedAt: _prCheckedAt, ...rest } = row as Row & { prCheckedAt?: Date | null };
  return { ...rest, pullRequest: parsePullRequestJson(row.pullRequest) } as SessionView<Row>;
}
