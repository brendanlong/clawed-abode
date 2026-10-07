import { describe, it, expect } from 'vitest';
import { llmProxyEnv, modelChangeNeedsRestart, usesLlmProxy } from './llm-proxy';

describe('usesLlmProxy', () => {
  it('routes provider-prefixed models through the proxy and never Claude models', () => {
    expect(usesLlmProxy('openai/gpt-6-astra')).toBe(true);
    for (const model of ['opus[1m]', 'sonnet', 'claude-opus-5-5', 'claude-haiku-4-5-20251001']) {
      expect(usesLlmProxy(model)).toBe(false);
    }
    expect(usesLlmProxy(undefined)).toBe(false);
  });
});

describe('modelChangeNeedsRestart', () => {
  it('restarts for any change that involves a proxied model', () => {
    expect(modelChangeNeedsRestart('opus', 'openai/gpt-6-astra')).toBe(true);
    expect(modelChangeNeedsRestart('openai/gpt-6-astra', undefined)).toBe(true);
    expect(modelChangeNeedsRestart('openai/gpt-6-astra', 'openai/gpt-6-sol')).toBe(true);
  });

  it('switches Claude models and unchanged models live', () => {
    expect(modelChangeNeedsRestart('opus', 'sonnet')).toBe(false);
    expect(modelChangeNeedsRestart(undefined, 'opus')).toBe(false);
    expect(modelChangeNeedsRestart('openai/gpt-6-astra', 'openai/gpt-6-astra')).toBe(false);
  });
});

describe('llmProxyEnv', () => {
  it('points the CLI at the proxy and maps GPT-6 aliases by tier', () => {
    const env = llmProxyEnv('openai/gpt-6-astra', { url: 'http://proxy', key: 'sk-proxy' });
    expect(env).toEqual({
      ANTHROPIC_BASE_URL: 'http://proxy',
      ANTHROPIC_AUTH_TOKEN: 'sk-proxy',
      ANTHROPIC_DEFAULT_FABLE_MODEL: 'openai/gpt-6-astra',
      ANTHROPIC_DEFAULT_OPUS_MODEL: 'openai/gpt-6.1-sol',
      ANTHROPIC_DEFAULT_SONNET_MODEL: 'openai/gpt-6.1-sol',
      ANTHROPIC_DEFAULT_HAIKU_MODEL: 'openai/gpt-6-luna',
    });
  });

  it('maps every alias to the model itself outside a known family', () => {
    const env = llmProxyEnv('acme/big', { url: 'http://proxy', key: undefined });
    expect(env.ANTHROPIC_DEFAULT_FABLE_MODEL).toBe('acme/big');
    expect(env.ANTHROPIC_DEFAULT_HAIKU_MODEL).toBe('acme/big');
    // The CLI needs a credential even when the proxy has none.
    expect(env.ANTHROPIC_AUTH_TOKEN).toBeTruthy();
  });
});
