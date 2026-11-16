import { z } from 'zod';
import { DEFAULT_CLAUDE_MODEL } from './claude-model';

export const LOG_LEVELS = ['debug', 'info', 'warn', 'error'] as const;

/** A percentage systemd accepts: at most two decimals, within [min, max]. */
function isSystemdPercent(value: string, min: number, max: number): boolean {
  const match = /^(\d+(?:\.\d{1,2})?)%$/.exec(value);
  return match !== null && Number(match[1]) >= min && Number(match[1]) <= max;
}

/** A systemd memory limit: a size like 64G, a % of RAM, or `infinity`. */
function systemdMemory(min: 0 | 1) {
  return z
    .string()
    .refine(
      (v) =>
        v === 'infinity' ||
        isSystemdPercent(v, min, 100) ||
        (/^\d+(\.\d+)?[KMGTPE]?$/.test(v) && parseFloat(v) >= min),
      `e.g. 64G, 85%, or infinity${min > 0 ? ' (not 0)' : ''}`
    );
}

/** Treat `VAR=` (common in .env templates) as unset. */
function emptyToUndefined(value: unknown): unknown {
  return value === '' ? undefined : value;
}

/** An optional base URL, without a trailing slash so callers can append paths. */
const baseUrl = z.preprocess(
  emptyToUndefined,
  z
    .string()
    .url()
    .transform((url) => url.replace(/\/+$/, ''))
    .optional()
);

// What each variable does is documented for operators in .env.example; comments
// here only explain validation choices.
const envSchema = z
  .object({
    DATABASE_URL: z.string().default('file:./data/dev.db'),
    GITHUB_TOKEN: z.string().optional(),
    CLAUDE_CODE_OAUTH_TOKEN: z.string().optional().default(''),
    CLAUDE_MODEL: z.string().default(DEFAULT_CLAUDE_MODEL),
    SESSION_BRANCH_PREFIX: z.string().default('claude/'),
    // Base64-encoded so the Argon2 hash's `$`s survive dotenv.
    PASSWORD_HASH: z
      .string()
      .optional()
      .transform((val) => (val ? Buffer.from(val, 'base64').toString('utf-8') : undefined)),
    ENCRYPTION_KEY: z.string().min(32).optional(),
    // Unset, it is derived from the request (src/lib/app-origin.ts).
    // Validated (unlike CODE_SERVER_URL) because a typo here doesn't degrade — it
    // produces a redirect_uri the authorization server rejects.
    APP_URL: z.string().url().optional(),
    // Intentionally free-form (not z.string().url()): it is operator-controlled and
    // may legitimately be a relative reverse-proxy path like "/editor".
    CODE_SERVER_URL: z.string().optional(),
    // Both or neither (refined below): the port without a URL would serve files
    // no agent links to.
    PUBLIC_FILES_PORT: z.preprocess(
      emptyToUndefined,
      z.coerce.number().int().min(1).max(65535).optional()
    ),
    // Origin only: the server serves /{sessionId}/… at its root.
    PUBLIC_FILES_URL: z.preprocess(
      emptyToUndefined,
      z
        .string()
        .url()
        .refine((url) => new URL(url).pathname === '/', 'must be an origin, with no path')
        .optional()
    ),
    TTS_BASE_URL: baseUrl,
    TTS_API_KEY: z.preprocess(emptyToUndefined, z.string().optional()),
    TTS_MODEL: z.preprocess(emptyToUndefined, z.string().default('hexgrad/kokoro-82m')),
    TTS_MAX_CONCURRENCY: z.preprocess(
      emptyToUndefined,
      z.coerce.number().int().min(1).max(16).default(4)
    ),
    LLM_PROXY_URL: baseUrl,
    LLM_PROXY_KEY: z.preprocess(emptyToUndefined, z.string().optional()),
    SESSIONS_MEMORY_MAX: z.preprocess(emptyToUndefined, systemdMemory(1).default('85%')),
    SESSIONS_MEMORY_SWAP_MAX: z.preprocess(emptyToUndefined, systemdMemory(0).default('0')),
    SESSIONS_CPU_QUOTA: z.preprocess(
      emptyToUndefined,
      z
        .string()
        .refine((v) => isSystemdPercent(v, 0.01, Infinity), 'e.g. 2200% (100% is one core)')
        .optional()
    ),
    LOG_LEVEL: z.enum(LOG_LEVELS).default('info'),
  })
  .refine((e) => (e.PUBLIC_FILES_PORT === undefined) === (e.PUBLIC_FILES_URL === undefined), {
    message: 'Set both PUBLIC_FILES_PORT and PUBLIC_FILES_URL, or neither',
    path: ['PUBLIC_FILES_URL'],
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
