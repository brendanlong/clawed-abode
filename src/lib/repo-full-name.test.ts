import { describe, expect, it } from 'vitest';
import { NO_REPO_SENTINEL, repoFullNameSchema, repoSettingsKeySchema } from './repo-full-name';

describe('repoFullNameSchema', () => {
  it.each(['owner/repo', 'my-org/my.repo', 'user_corp/repo_name', 'o/.github', 'o/a..b', 'O1/R-2'])(
    'accepts %s',
    (name) => {
      expect(repoFullNameSchema.safeParse(name).success).toBe(true);
    }
  );

  it.each([
    ['a dot in the owner', 'my.org/repo'],
    ['the reserved name "."', 'owner/.'],
    ['the reserved name ".."', 'owner/..'],
    ['a missing owner', '/repo'],
    ['a missing repo', 'owner/'],
    ['extra path segments', 'owner/repo/extra'],
    ['traversal in the owner', '../repo'],
    ['whitespace', 'owner/re po'],
    ['the No Repository sentinel', NO_REPO_SENTINEL],
  ])('rejects %s', (_, name) => {
    expect(repoFullNameSchema.safeParse(name).success).toBe(false);
  });
});

describe('repoSettingsKeySchema', () => {
  it('accepts a repo full name or the No Repository sentinel', () => {
    expect(repoSettingsKeySchema.safeParse('owner/repo').success).toBe(true);
    expect(repoSettingsKeySchema.safeParse(NO_REPO_SENTINEL).success).toBe(true);
  });

  it('rejects anything else with a message naming both forms', () => {
    const result = repoSettingsKeySchema.safeParse('__other__');
    expect(result.success).toBe(false);
    expect(result.error?.issues[0].message).toContain(NO_REPO_SENTINEL);
  });
});
