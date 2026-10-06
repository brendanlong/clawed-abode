import { z } from 'zod';

export interface EnvVar {
  id: string;
  name: string;
  value: string;
  isSecret: boolean;
}

export const mcpHttpServerTypeSchema = z.enum(['http', 'sse']);
export const mcpServerTypeSchema = z.enum(['stdio', ...mcpHttpServerTypeSchema.options]);
export type McpServerType = z.infer<typeof mcpServerTypeSchema>;

/** How an http/sse server authenticates: static headers, or an OAuth grant. */
export const mcpAuthTypeSchema = z.enum(['headers', 'oauth']);
export type McpAuthType = z.infer<typeof mcpAuthTypeSchema>;

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
  type: z.infer<typeof mcpHttpServerTypeSchema>;
  url: string;
  headers?: Record<string, string>;
  /**
   * The stored grant to mint an `Authorization` header from, loaded with the
   * server row so the common (unexpired) case needs no further query. Resolved
   * and stripped by `applyMcpOAuthHeaders` after merging, so neither the id nor
   * the ciphertext ever reaches the SDK config.
   */
  oauth?: { id: string; accessToken: string | null; expiresAt: Date | null };
}

export type ResolvedMcpServer = ResolvedStdioMcpServer | ResolvedHttpMcpServer;
