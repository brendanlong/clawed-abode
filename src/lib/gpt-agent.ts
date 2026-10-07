import type { SDKMessage } from '@anthropic-ai/claude-agent-sdk';
import { AGENT_NAME_ENV } from './agent-name';
import {
  CLAUDE_CREDENTIAL_ENV_VARS,
  GPT_AGENT_MODELS,
  llmProxyEnv,
  type LlmProxyConfig,
} from './llm-proxy';

/**
 * Pure parts of the gpt_agent built-in tool, which lets a Claude session run a
 * task on a GPT model (doc/settings.md "GPT Agents").
 */

export type GptAgentTier = keyof typeof GPT_AGENT_MODELS;
export const GPT_AGENT_TIERS = Object.keys(GPT_AGENT_MODELS) as [GptAgentTier, ...GptAgentTier[]];

export const GPT_AGENT_TOOL_DESCRIPTION = `Run a task on an OpenAI GPT-6 model as a subagent: a one-shot agent with your tools, in this session's working directory, that returns its final answer. It knows nothing of this conversation, so the prompt must contain everything it needs. Your own Agent subagents remain the default; use this when a different model family is worth it:
- sol: strong at coding. Good for independent reviews, e.g. a second code review alongside your own, since a different model family catches different mistakes.
- luna: cheap and fast, for simple, well-defined tasks.
- astra: the strongest at conceptual math, and very expensive. Use it only for tasks that need conceptual math (proofs, derivations, checking mathematical reasoning), never for general coding or reviews.
Set run_in_background for long tasks: you get control back at once and the result arrives later as a message.`;

/**
 * The run's env: the session's, pointed at the proxy for `model`, without Claude
 * credentials or the session's messaging name (which would register the run as
 * a second peer under it).
 */
export function gptAgentEnv(
  sessionEnv: Record<string, string | undefined>,
  model: string,
  proxy: LlmProxyConfig
): Record<string, string | undefined> {
  const env = { ...sessionEnv };
  for (const name of [...CLAUDE_CREDENTIAL_ENV_VARS, AGENT_NAME_ENV]) delete env[name];
  return { ...env, ...llmProxyEnv(model, proxy) };
}

export interface GptAgentOutcome {
  text: string;
  isError: boolean;
  /** Stopped by an interrupt or its session's teardown, so nobody wants the result. */
  cancelled?: boolean;
}

/** The outcome a run's `result` message reports, or null for any other message. */
export function gptAgentOutcome(message: SDKMessage): GptAgentOutcome | null {
  if (message.type !== 'result') return null;
  if (message.subtype === 'success') return { text: message.result, isError: message.is_error };
  return {
    text: `GPT agent failed (${message.subtype}): ${message.errors.join('; ')}`,
    isError: true,
  };
}

/** The message that brings a background run's result back to the session. */
export function backgroundResultMessage(
  tier: GptAgentTier,
  description: string,
  outcome: GptAgentOutcome
): string {
  const status = outcome.isError ? 'failed' : 'finished';
  return `[Background GPT agent "${description}" (${tier}) ${status}. This is its result, not a message from the user.]\n\n${outcome.text}`;
}
