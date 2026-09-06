import { z } from 'zod';

export const pullRequestInfoSchema = z.object({
  number: z.number().int(),
  title: z.string(),
  state: z.enum(['open', 'closed', 'merged']),
  draft: z.boolean(),
  url: z.string(),
  author: z.string(),
  updatedAt: z.string(),
});

export type PullRequestInfo = z.infer<typeof pullRequestInfoSchema>;
export type PrState = PullRequestInfo['state'];

/**
 * Decode the `Session.pullRequest` JSON column. Unparseable or absent values read
 * as "no PR" so a bad row can never break the session list.
 */
export function parsePullRequestJson(json: string | null): PullRequestInfo | null {
  if (!json) return null;
  try {
    const parsed = pullRequestInfoSchema.safeParse(JSON.parse(json));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

export function serializePullRequest(pullRequest: PullRequestInfo | null): string | null {
  return pullRequest ? JSON.stringify(pullRequest) : null;
}
