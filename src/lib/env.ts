import { z } from 'zod';

const envSchema = z.object({
  DATABASE_URL: z.string().default('file:./data/dev.db'),
  GITHUB_TOKEN: z.string().optional(),
  // Claude Code OAuth token (run `claude setup-token` to generate)
  // Optional if configured via Settings UI instead
  CLAUDE_CODE_OAUTH_TOKEN: z.string().optional().default(''),
  // Claude model to use (e.g., "opus", "sonnet", "claude-opus-4-5-20251101")
  CLAUDE_MODEL: z.string().default('opus[1m]'),
  NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),
  // Server port for HTTP server
  PORT: z
    .string()
    .optional()
    .transform((val) => (val ? parseInt(val, 10) : 3000)),
  // Next.js runtime environment (set by Next.js framework)
  NEXT_RUNTIME: z.enum(['nodejs', 'edge']).optional(),
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
});

export type Env = z.infer<typeof envSchema>;

/**
 * Parse and validate environment variables.
 * Called on each property access to support dynamic env changes (e.g., in tests).
 */
function getEnv(): Env {
  const isBuildTime = process.env.NEXT_PHASE === 'phase-production-build';

  const parsed = envSchema.safeParse(process.env);

  if (!parsed.success) {
    if (isBuildTime) {
      return envSchema.parse(process.env);
    }
    console.error('Invalid environment variables:', parsed.error.flatten().fieldErrors);
    throw new Error('Invalid environment variables');
  }

  return parsed.data;
}

/**
 * Proxy that calls getEnv() on each property access.
 * This supports dynamic env changes in tests.
 */
export const env: Env = new Proxy({} as Env, {
  get(_target, prop: keyof Env) {
    return getEnv()[prop];
  },
});
