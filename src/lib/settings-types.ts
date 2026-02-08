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
