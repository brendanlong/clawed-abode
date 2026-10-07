import Anthropic from '@anthropic-ai/sdk';
import { z } from 'zod';
import { classifyClaudeCredential } from '@/lib/claude-credential';
import { env } from '@/lib/env';
import { usesLlmProxy } from '@/lib/llm-proxy';
import { createLogger, toError } from '@/lib/logger';
import { loadClaudeCredential } from './settings-merger';

const log = createLogger('model-suggestions');

/** Well-known short aliases that always appear as suggestions */
const WELL_KNOWN_ALIASES = [
  'opus[1m]',
  'sonnet[1m]',
  'fable[1m]',
  'opus',
  'sonnet',
  'haiku',
  'fable',
];

/** Cache for model suggestions */
let cachedModels: string[] | null = null;
let cacheTimestamp = 0;
const CACHE_TTL_MS = 60 * 60 * 1000; // 1 hour

/**
 * Strip the date suffix from a model ID to infer the alias.
 * e.g., "claude-sonnet-4-5-20250929" -> "claude-sonnet-4-5"
 */
export function inferAlias(modelId: string): string | null {
  // Match pattern: anything followed by -YYYYMMDD
  const match = modelId.match(/^(.+)-(\d{8})$/);
  if (match) {
    return match[1];
  }
  return null;
}

/**
 * Fetch available model IDs from the Anthropic API.
 * Returns model IDs and inferred aliases, deduplicated and sorted.
 */
async function fetchModelsFromApi(): Promise<string[]> {
  const credential = await loadClaudeCredential();
  if (!credential) {
    log.debug('No credentials available, skipping API model fetch');
    return [];
  }

  try {
    const client = new Anthropic(classifyClaudeCredential(credential));

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

const modelListSchema = z.object({ data: z.array(z.object({ id: z.string() })) });

/**
 * The proxied models in an OpenAI-style `/v1/models` response. Names without a
 * provider prefix wouldn't route through the proxy, so they're left out.
 */
export function parseProxiedModels(body: unknown): string[] {
  const parsed = modelListSchema.safeParse(body);
  if (!parsed.success) return [];
  return parsed.data.data
    .map((model) => model.id)
    .filter(usesLlmProxy)
    .sort();
}

async function fetchProxiedModels(): Promise<string[]> {
  if (!env.LLM_PROXY_URL) return [];
  try {
    const response = await fetch(`${env.LLM_PROXY_URL.replace(/\/$/, '')}/v1/models`, {
      headers: env.LLM_PROXY_KEY ? { Authorization: `Bearer ${env.LLM_PROXY_KEY}` } : {},
      signal: AbortSignal.timeout(10_000),
    });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    return parseProxiedModels(await response.json());
  } catch (error) {
    log.warn('Failed to fetch models from LLM proxy', { error: toError(error).message });
    return [];
  }
}

/**
 * Get model suggestions: well-known aliases + API models + inferred aliases + proxied models.
 * Results are cached for 1 hour.
 */
export async function getModelSuggestions(): Promise<string[]> {
  const now = Date.now();
  if (cachedModels && now - cacheTimestamp < CACHE_TTL_MS) {
    return cachedModels;
  }

  const [apiModels, proxiedModels] = await Promise.all([
    fetchModelsFromApi(),
    fetchProxiedModels(),
  ]);

  // Well-known aliases, then aliases inferred from API models (e.g.
  // "claude-sonnet-4-5" from "claude-sonnet-4-5-20250929"), then full IDs; the
  // Set keeps each name's first position.
  const inferredAliases = apiModels.map(inferAlias).filter((alias) => alias !== null);
  const result = [
    ...new Set([...WELL_KNOWN_ALIASES, ...inferredAliases, ...apiModels, ...proxiedModels]),
  ];

  // A configured proxy that listed nothing is misconfigured or still starting;
  // retry on the next request rather than hiding its models for an hour.
  if (!env.LLM_PROXY_URL || proxiedModels.length > 0) {
    cachedModels = result;
    cacheTimestamp = now;
  }

  return result;
}
