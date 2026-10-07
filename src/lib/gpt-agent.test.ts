import { describe, expect, it } from 'vitest';
import type { SDKMessage } from '@anthropic-ai/claude-agent-sdk';
import { backgroundResultMessage, gptAgentEnv, gptAgentOutcome } from './gpt-agent';

describe('gptAgentEnv', () => {
  it('points the run at the proxy without Claude credentials or the messaging name', () => {
    const env = gptAgentEnv(
      {
        PATH: '/bin',
        CLAUDE_CODE_OAUTH_TOKEN: 'sk-ant-oat',
        ANTHROPIC_API_KEY: 'sk-ant-api',
        CLAUDE_CODE_SESSION_NAME: 'parent-ab12',
      },
      'openai/gpt-6.1-sol',
      { url: 'http://proxy', key: 'sk-proxy' }
    );
    expect(env).toMatchObject({
      PATH: '/bin',
      ANTHROPIC_BASE_URL: 'http://proxy',
      ANTHROPIC_AUTH_TOKEN: 'sk-proxy',
    });
    expect(env).not.toHaveProperty('CLAUDE_CODE_OAUTH_TOKEN');
    expect(env).not.toHaveProperty('ANTHROPIC_API_KEY');
    expect(env).not.toHaveProperty('CLAUDE_CODE_SESSION_NAME');
  });
});

describe('gptAgentOutcome', () => {
  it('reads the final answer or the errors from a result, and ignores other messages', () => {
    const success = { type: 'result', subtype: 'success', is_error: false, result: 'done' };
    const failure = {
      type: 'result',
      subtype: 'error_max_turns',
      is_error: true,
      errors: ['a', 'b'],
    };
    expect(gptAgentOutcome(success as SDKMessage)).toEqual({ text: 'done', isError: false });
    expect(gptAgentOutcome(failure as SDKMessage)).toEqual({
      text: 'GPT agent failed (error_max_turns): a; b',
      isError: true,
    });
    expect(gptAgentOutcome({ type: 'assistant' } as SDKMessage)).toBeNull();
  });
});

describe('backgroundResultMessage', () => {
  it('labels the result as not from the user', () => {
    const text = backgroundResultMessage('sol', 'review', { text: 'fine', isError: false });
    expect(text).toMatch(
      /^\[Background GPT agent "review" \(sol\) finished\. .*not a message from the user\.\]\n\nfine$/
    );
  });
});
