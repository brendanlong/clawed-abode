export interface EnvVar {
  id: string;
  name: string;
  value: string;
  isSecret: boolean;
}

export type McpServerType = 'stdio' | 'http' | 'sse';

/** How an http/sse server authenticates: static headers, or an OAuth grant. */
export type McpAuthType = 'headers' | 'oauth';

export interface McpOAuthStatus {
  state: 'disconnected' | 'connected' | 'error';
  clientId: string | null;
  /** True when the user typed the client ID, so the settings form re-populates it. */
  clientIdIsManual: boolean;
  scope: string | null;
  authorizedAt: Date | null;
  /** Why the last connect or refresh failed; a connected server can still have one. */
  error: string | null;
}

export interface McpServer {
  id: string;
  name: string;
  type: McpServerType;
  command: string;
  args: string[];
  env: Record<string, { value: string; isSecret: boolean }>;
  url?: string;
  headers: Record<string, { value: string; isSecret: boolean }>;
  authType: McpAuthType;
  /** Present only when authType is "oauth". */
  oauth?: McpOAuthStatus;
}

export interface ValidationResult {
  success: boolean;
  error?: string;
  tools?: string[];
}

// ─── Resolved (decrypted, merged) settings handed to the session runner ────

export interface ResolvedEnvVar {
  name: string;
  value: string;
}

export interface ResolvedStdioMcpServer {
  name: string;
  type: 'stdio';
  command: string;
  args?: string[];
  env?: Record<string, string>;
}

export interface ResolvedHttpMcpServer {
  name: string;
  type: 'http' | 'sse';
  url: string;
  headers?: Record<string, string>;
  /**
   * McpOAuth row to mint an `Authorization` header from. Resolved (and stripped)
   * by `applyMcpOAuthHeaders` after merging, so it never reaches the SDK config.
   */
  oauthCredentialId?: string;
}

export type ResolvedMcpServer = ResolvedStdioMcpServer | ResolvedHttpMcpServer;
