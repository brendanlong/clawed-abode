import { z } from 'zod';
import { DEFAULT_CLAUDE_MODEL } from './claude-model';

export const LOG_LEVELS = ['debug', 'info', 'warn', 'error'] as const;

const envSchema = z.object({
  DATABASE_URL: z.string().default('file:./data/dev.db'),
  GITHUB_TOKEN: z.string().optional(),
  // Claude Code OAuth token (run `claude setup-token` to generate)
  // Optional if configured via Settings UI instead
  CLAUDE_CODE_OAUTH_TOKEN: z.string().optional().default(''),
  // Claude model to use (e.g., "opus", "sonnet", "claude-opus-4-5-20251101")
  CLAUDE_MODEL: z.string().default(DEFAULT_CLAUDE_MODEL),
  // Prefix for session branches (e.g., "claude/" creates branches like "claude/{sessionId}")
  SESSION_BRANCH_PREFIX: z.string().default('claude/'),
  // Base64-encoded Argon2 hash for authentication (generate with: pnpm hash-password <yourpassword>)
  PASSWORD_HASH: z
    .string()
    .optional()
    .transform((val) => (val ? Buffer.from(val, 'base64').toString('utf-8') : undefined)),
  // 32+ character key for encrypting secrets (env vars, MCP API keys)
  // Generate with: openssl rand -base64 32
  ENCRYPTION_KEY: z.string().min(32).optional(),
  // Base URL of a self-hosted code-server (browser VS Code) instance used to
  // view/edit session worktrees remotely (e.g. https://host.tailnet.ts.net:8443).
  // When unset, the "Open in VS Code" button is hidden. See scripts/setup-code-server.sh.
  // Intentionally free-form (not z.string().url()): it is operator-controlled and
  // may legitimately be a relative reverse-proxy path like "/editor".
  CODE_SERVER_URL: z.string().optional(),
  // Minimum level the server logger writes (see src/lib/logger.ts).
  LOG_LEVEL: z.enum(LOG_LEVELS).default('info'),
});

export type Env = z.infer<typeof envSchema>;

let cachedEnv: Env | null = null;

/**
 * Validate `process.env` once and cache the result. Throws with every field
 * error listed so a misconfigured deployment fails at boot (instrumentation
 * calls this eagerly) rather than on the first request that happens to read a
 * bad variable.
 */
export function getEnv(): Env {
  if (cachedEnv) return cachedEnv;
  const parsed = envSchema.safeParse(process.env);
  if (!parsed.success) {
    const fieldErrors = z.flattenError(parsed.error).fieldErrors;
    const details = Object.entries(fieldErrors)
      .map(([name, errors]) => `${name}: ${errors?.join('; ')}`)
      .join('\n  ');
    throw new Error(`Invalid environment variables:\n  ${details}`);
  }
  cachedEnv = parsed.data;
  return cachedEnv;
}

/** Drop the cached parse so the next read re-validates `process.env`. For tests that mutate env. */
export function resetEnvCache(): void {
  cachedEnv = null;
}

/** Validated env, parsed lazily on first access and cached for the process lifetime. */
export const env: Env = new Proxy({} as Env, {
  get(_target, prop: keyof Env) {
    return getEnv()[prop];
  },
});
