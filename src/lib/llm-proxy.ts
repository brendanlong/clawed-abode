/**
 * Non-Claude models run through an Anthropic-compatible proxy such as LiteLLM
 * (doc/settings.md "Proxied Models"). A model is proxied when its name has a
 * provider prefix (`openai/gpt-6-astra`), which no Claude model name has — so
 * Claude traffic can never be sent through the proxy by accident.
 */
export function usesLlmProxy(model: string | undefined): model is string {
  return model?.includes('/') ?? false;
}

/**
 * Whether switching a live query between these models needs a new CLI process.
 * The proxy endpoint and the subagent model mapping are environment variables,
 * bound when the process starts; only Claude-to-Claude switches can go through
 * `setModel`.
 */
export function modelChangeNeedsRestart(from: string | undefined, to: string | undefined): boolean {
  return from !== to && (usesLlmProxy(from) || usesLlmProxy(to));
}

export interface LlmProxyConfig {
  url: string;
  key: string | undefined;
}

/** Credentials that would send Claude subscription or API billing through the proxy. */
export const CLAUDE_CREDENTIAL_ENV_VARS = [
  'CLAUDE_CODE_OAUTH_TOKEN',
  'CLAUDE_CODE_OAUTH_REFRESH_TOKEN',
  'ANTHROPIC_API_KEY',
] as const;

type ModelTier = 'fable' | 'opus' | 'sonnet' | 'haiku';

/**
 * The comparable model for each Claude Code model alias, per provider family, so
 * subagents and background calls (session titles, Explore) get a sensible tier.
 * A model outside every family maps all aliases to itself.
 */
const MODEL_FAMILIES: { prefix: string; tiers: Record<ModelTier, string> }[] = [
  {
    prefix: 'openai/gpt-6',
    tiers: {
      fable: 'openai/gpt-6-astra',
      opus: 'openai/gpt-6.1-sol',
      sonnet: 'openai/gpt-6.1-sol',
      haiku: 'openai/gpt-6-luna',
    },
  },
];

const GPT_6_TIERS = MODEL_FAMILIES[0].tiers;

/**
 * The GPT models Claude sessions can run as subagents
 * (doc/settings.md "GPT Subagents"), named by their model's own tier name.
 */
export const GPT_SUBAGENT_MODELS = {
  astra: GPT_6_TIERS.fable,
  sol: GPT_6_TIERS.opus,
  luna: GPT_6_TIERS.haiku,
} as const;

export function proxiedModelTiers(model: string): Record<ModelTier, string> {
  return (
    MODEL_FAMILIES.find((family) => model.startsWith(family.prefix))?.tiers ?? {
      fable: model,
      opus: model,
      sonnet: model,
      haiku: model,
    }
  );
}

/**
 * Env overrides that point the CLI at the proxy for `model`. Every alias the CLI
 * resolves on its own must map to a proxied model: the proxy can't serve Claude.
 */
export function llmProxyEnv(model: string, proxy: LlmProxyConfig): Record<string, string> {
  const tiers = proxiedModelTiers(model);
  return {
    ANTHROPIC_BASE_URL: proxy.url,
    // The CLI needs some credential; a proxy without a key accepts any.
    ANTHROPIC_AUTH_TOKEN: proxy.key ?? 'unused',
    ANTHROPIC_DEFAULT_FABLE_MODEL: tiers.fable,
    ANTHROPIC_DEFAULT_OPUS_MODEL: tiers.opus,
    ANTHROPIC_DEFAULT_SONNET_MODEL: tiers.sonnet,
    ANTHROPIC_DEFAULT_HAIKU_MODEL: tiers.haiku,
  };
}
