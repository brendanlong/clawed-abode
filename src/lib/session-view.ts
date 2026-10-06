import { parsePullRequestJson, type PullRequestInfo } from './pull-request';
import { canTransition } from './session-transitions';

type SessionViewRow = { pullRequest: string | null; status: string };

/**
 * The shape of a session as the API returns it: the DB row with the JSON
 * `pullRequest` column decoded, `prCheckedAt` dropped (it only feeds the
 * server's own staleness check), and whether Start / Stop apply right now —
 * from the server's transition table, so the UI never restates the rule. Every
 * router/SSE path that hands a session to the client goes through
 * {@link toSessionView} so the two can't drift.
 */
export type SessionView<Row extends SessionViewRow> = Omit<Row, 'pullRequest' | 'prCheckedAt'> & {
  pullRequest: PullRequestInfo | null;
  canStart: boolean;
  canStop: boolean;
};

export function toSessionView<Row extends SessionViewRow>(row: Row): SessionView<Row> {
  const { prCheckedAt: _prCheckedAt, ...rest } = row as Row & { prCheckedAt?: Date | null };
  return {
    ...rest,
    pullRequest: parsePullRequestJson(row.pullRequest),
    canStart: canTransition('start', row.status),
    canStop: canTransition('stop', row.status),
  } as SessionView<Row>;
}
