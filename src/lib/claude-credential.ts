/**
 * Split a Claude credential into the Anthropic SDK's constructor shape.
 * Claude Code OAuth tokens start with "sk-ant-oat" (sent as a bearer token; an
 * x-api-key header is rejected with 401); anything else is an API key.
 * `apiKey: null` keeps the SDK from also sending ANTHROPIC_API_KEY from the env.
 */
export function classifyClaudeCredential(
  credential: string
): { apiKey: string } | { apiKey: null; authToken: string } {
  return credential.startsWith('sk-ant-oat')
    ? { apiKey: null, authToken: credential }
    : { apiKey: credential };
}
