import { z } from 'zod';

/** Settings key for "No Repository" sessions, in place of an `owner/repo`. */
export const NO_REPO_SENTINEL = '__no_repo__';

/**
 * GitHub owners are letters, digits, and hyphens (`_` appears in Enterprise
 * Managed User names), never dots; repo names may also contain dots, except
 * the reserved `.` and `..`. The name lands in API paths and as the clone's
 * directory, so `owner/..` must not pass.
 */
const REPO_FULL_NAME_PATTERN = /^[\w-]+\/(?!\.\.?$)[\w.-]+$/;

export const repoFullNameSchema = z.string().regex(REPO_FULL_NAME_PATTERN, {
  message: 'Invalid repository name format. Expected "owner/repo"',
});

/** A repo settings key: an `owner/repo`, or the No Repository sentinel. */
export const repoSettingsKeySchema = z
  .string()
  .refine((key) => key === NO_REPO_SENTINEL || REPO_FULL_NAME_PATTERN.test(key), {
    message: `Invalid repository name format. Expected "owner/repo" or "${NO_REPO_SENTINEL}"`,
  });
