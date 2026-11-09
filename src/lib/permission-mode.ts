import { z } from 'zod';

/**
 * The Claude Code permission modes a session can run in (doc/settings.md
 * "Permission Mode"). `auto` lets a classifier approve or deny each tool call
 * and asks the user when it can't decide; `bypassPermissions` approves
 * everything.
 */
export const permissionModeSchema = z.enum(['auto', 'bypassPermissions']);

export type AppPermissionMode = z.infer<typeof permissionModeSchema>;

export const DEFAULT_PERMISSION_MODE: AppPermissionMode = 'auto';
