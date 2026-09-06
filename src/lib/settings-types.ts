export interface EnvVar {
  id: string;
  name: string;
  value: string;
  isSecret: boolean;
}

export type McpServerType = 'stdio' | 'http' | 'sse';

export interface McpServer {
  id: string;
  name: string;
  type: McpServerType;
  command: string;
  args: string[];
  env: Record<string, { value: string; isSecret: boolean }>;
  url?: string;
  headers: Record<string, { value: string; isSecret: boolean }>;
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
}

export type ResolvedMcpServer = ResolvedStdioMcpServer | ResolvedHttpMcpServer;
