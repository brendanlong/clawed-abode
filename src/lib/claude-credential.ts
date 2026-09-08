/**
 * Split a Claude credential into the Anthropic SDK's constructor shape.
 * API keys start with "sk-ant-"; anything else is a Claude Code OAuth token.
 */
export function classifyClaudeCredential(
  credential: string
): { apiKey: string } | { authToken: string } {
  return credential.startsWith('sk-ant-') ? { apiKey: credential } : { authToken: credential };
}
