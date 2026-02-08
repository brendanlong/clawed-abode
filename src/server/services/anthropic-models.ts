import Anthropic from '@anthropic-ai/sdk';
import { env } from '@/lib/env';
import { decrypt } from '@/lib/crypto';
import { prisma } from '@/lib/prisma';
import { createLogger, toError } from '@/lib/logger';

const log = createLogger('anthropic-models');

/** Well-known short aliases that always appear as suggestions */
const WELL_KNOWN_ALIASES = ['opus', 'sonnet', 'haiku'];

/** Cache for model suggestions */
let cachedModels: string[] | null = null;
let cacheTimestamp = 0;
const CACHE_TTL_MS = 60 * 60 * 1000; // 1 hour

/**
 * Strip the date suffix from a model ID to infer the alias.
 * e.g., "claude-sonnet-4-5-20250929" -> "claude-sonnet-4-5"
 */
function inferAlias(modelId: string): string | null {
  // Match pattern: anything followed by -YYYYMMDD
  const match = modelId.match(/^(.+)-(\d{8})$/);
  if (match) {
    return match[1];
  }
  return null;
}

/**
 * Get the OAuth token or API key to use for the Anthropic SDK.
 * Checks the DB first, then falls back to env var.
 */
async function getAuthCredentials(): Promise<{
  authToken?: string;
  apiKey?: string;
} | null> {
  // Check DB for stored API key
  const settings = await prisma.globalSettings.findUnique({
    where: { id: 'global' },
    select: { claudeApiKey: true },
  });

  if (settings?.claudeApiKey) {
    const decrypted = decrypt(settings.claudeApiKey);
    // Anthropic API keys start with "sk-ant-", OAuth tokens don't
    if (decrypted.startsWith('sk-ant-')) {
      return { apiKey: decrypted };
    }
    return { authToken: decrypted };
  }

  const envToken = env.CLAUDE_CODE_OAUTH_TOKEN;
  if (envToken) {
    if (envToken.startsWith('sk-ant-')) {
      return { apiKey: envToken };
    }
    return { authToken: envToken };
  }

  return null;
}

/**
 * Fetch available model IDs from the Anthropic API.
 * Returns model IDs and inferred aliases, deduplicated and sorted.
 */
async function fetchModelsFromApi(): Promise<string[]> {
  const credentials = await getAuthCredentials();
  if (!credentials) {
    log.debug('No credentials available, skipping API model fetch');
    return [];
  }

  try {
    const client = new Anthropic({
      ...credentials,
    });

    const models: string[] = [];
    // Use for-await to auto-paginate
    for await (const model of client.models.list({ limit: 100 })) {
      models.push(model.id);
    }

    return models;
  } catch (error) {
    log.debug('Failed to fetch models from API', { error: toError(error).message });
    return [];
  }
}

/**
 * Get model suggestions: well-known aliases + API models + inferred aliases.
 * Results are cached for 1 hour.
 */
export async function getModelSuggestions(): Promise<string[]> {
  const now = Date.now();
  if (cachedModels && now - cacheTimestamp < CACHE_TTL_MS) {
    return cachedModels;
  }

  const apiModels = await fetchModelsFromApi();

  // Build deduplicated set: aliases first, then inferred aliases, then full model IDs
  const seen = new Set<string>();
  const result: string[] = [];

  // 1. Well-known aliases first
  for (const alias of WELL_KNOWN_ALIASES) {
    if (!seen.has(alias)) {
      seen.add(alias);
      result.push(alias);
    }
  }

  // 2. Inferred aliases from API models (e.g., "claude-sonnet-4-5" from "claude-sonnet-4-5-20250929")
  for (const modelId of apiModels) {
    const alias = inferAlias(modelId);
    if (alias && !seen.has(alias)) {
      seen.add(alias);
      result.push(alias);
    }
  }

  // 3. Full model IDs from API
  for (const modelId of apiModels) {
    if (!seen.has(modelId)) {
      seen.add(modelId);
      result.push(modelId);
    }
  }

  cachedModels = result;
  cacheTimestamp = now;

  return result;
}

/** Exported for testing */
export { inferAlias };
