import { parsePullRequestJson, type PullRequestInfo } from './pull-request';

/**
 * The shape of a session as the API returns it: the DB row with the JSON
 * `pullRequest` column decoded. Every router/SSE path that hands a session to
 * the client goes through {@link toSessionView} so the two can't drift.
 */
export type SessionView<Row extends { pullRequest: string | null }> = Omit<Row, 'pullRequest'> & {
  pullRequest: PullRequestInfo | null;
};

export function toSessionView<Row extends { pullRequest: string | null }>(
  row: Row
): SessionView<Row> {
  return { ...row, pullRequest: parsePullRequestJson(row.pullRequest) };
}
