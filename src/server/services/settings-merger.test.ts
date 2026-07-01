import { describe, it, expect } from 'vitest';
import {
  mergeEnvVars,
  mergeMcpServers,
  mcpServersEqual,
  resolveClaudeModel,
  resolveAdvisorModel,
  DEFAULT_ADVISOR_MODEL,
} from './settings-merger';
import type { ContainerEnvVar, ContainerMcpServer } from './repo-settings';

describe('resolveClaudeModel', () => {
  it('prefers the per-repo model over global and env', () => {
    expect(resolveClaudeModel('repo-model', 'global-model', 'env-model')).toBe('repo-model');
  });

  it('falls back to the global model when no repo override', () => {
    expect(resolveClaudeModel(null, 'global-model', 'env-model')).toBe('global-model');
    expect(resolveClaudeModel(undefined, 'global-model', 'env-model')).toBe('global-model');
  });

  it('falls back to the env model when neither repo nor global is set', () => {
    expect(resolveClaudeModel(null, null, 'env-model')).toBe('env-model');
  });

  it('returns undefined when nothing is set', () => {
    expect(resolveClaudeModel(null, null, undefined)).toBeUndefined();
  });
});

describe('resolveAdvisorModel', () => {
  it('uses the global override when set', () => {
    expect(resolveAdvisorModel('claude-opus-4-8')).toBe('claude-opus-4-8');
  });

  it('falls back to the default advisor model when unset or blank', () => {
    expect(resolveAdvisorModel(null)).toBe(DEFAULT_ADVISOR_MODEL);
    expect(resolveAdvisorModel(undefined)).toBe(DEFAULT_ADVISOR_MODEL);
    expect(resolveAdvisorModel('')).toBe(DEFAULT_ADVISOR_MODEL);
    expect(resolveAdvisorModel('   ')).toBe(DEFAULT_ADVISOR_MODEL);
    expect(DEFAULT_ADVISOR_MODEL).toBe('claude-fable-5');
  });

  it('trims a surrounding-whitespace override', () => {
    expect(resolveAdvisorModel('  claude-opus-4-8  ')).toBe('claude-opus-4-8');
  });
});

describe('mergeEnvVars', () => {
  it('should return empty array when both inputs are empty', () => {
    expect(mergeEnvVars([], [])).toEqual([]);
  });

  it('should return global env vars when no repo vars exist', () => {
    const global: ContainerEnvVar[] = [
      { name: 'API_KEY', value: 'global-key' },
      { name: 'DEBUG', value: 'true' },
    ];
    const result = mergeEnvVars(global, []);
    expect(result).toEqual(global);
  });

  it('should return repo env vars when no global vars exist', () => {
    const repo: ContainerEnvVar[] = [{ name: 'REPO_VAR', value: 'repo-value' }];
    const result = mergeEnvVars([], repo);
    expect(result).toEqual(repo);
  });

  it('should merge global and repo env vars', () => {
    const global: ContainerEnvVar[] = [{ name: 'GLOBAL_VAR', value: 'global' }];
    const repo: ContainerEnvVar[] = [{ name: 'REPO_VAR', value: 'repo' }];
    const result = mergeEnvVars(global, repo);
    expect(result).toHaveLength(2);
    expect(result).toContainEqual({ name: 'GLOBAL_VAR', value: 'global' });
    expect(result).toContainEqual({ name: 'REPO_VAR', value: 'repo' });
  });

  it('should let per-repo env vars override global ones with the same name', () => {
    const global: ContainerEnvVar[] = [
      { name: 'API_KEY', value: 'global-key' },
      { name: 'SHARED', value: 'global-shared' },
    ];
    const repo: ContainerEnvVar[] = [
      { name: 'SHARED', value: 'repo-shared' },
      { name: 'REPO_ONLY', value: 'repo' },
    ];
    const result = mergeEnvVars(global, repo);
    expect(result).toHaveLength(3);
    expect(result).toContainEqual({ name: 'API_KEY', value: 'global-key' });
    expect(result).toContainEqual({ name: 'SHARED', value: 'repo-shared' });
    expect(result).toContainEqual({ name: 'REPO_ONLY', value: 'repo' });
  });
});

describe('mergeMcpServers', () => {
  it('should return empty array when both inputs are empty', () => {
    expect(mergeMcpServers([], [])).toEqual([]);
  });

  it('should return global servers when no repo servers exist', () => {
    const global: ContainerMcpServer[] = [
      { name: 'memory', type: 'stdio', command: 'npx', args: ['@anthropic/mcp-server-memory'] },
    ];
    const result = mergeMcpServers(global, []);
    expect(result).toEqual(global);
  });

  it('should return repo servers when no global servers exist', () => {
    const repo: ContainerMcpServer[] = [
      { name: 'repo-server', type: 'http', url: 'https://example.com' },
    ];
    const result = mergeMcpServers([], repo);
    expect(result).toEqual(repo);
  });

  it('should merge global and repo MCP servers', () => {
    const global: ContainerMcpServer[] = [
      { name: 'memory', type: 'stdio', command: 'npx', args: ['@anthropic/mcp-server-memory'] },
    ];
    const repo: ContainerMcpServer[] = [
      { name: 'repo-server', type: 'http', url: 'https://example.com' },
    ];
    const result = mergeMcpServers(global, repo);
    expect(result).toHaveLength(2);
    expect(result.find((s) => s.name === 'memory')).toBeDefined();
    expect(result.find((s) => s.name === 'repo-server')).toBeDefined();
  });

  it('should let per-repo servers override global ones with the same name', () => {
    const global: ContainerMcpServer[] = [
      { name: 'shared', type: 'stdio', command: 'global-cmd' },
      { name: 'global-only', type: 'http', url: 'https://global.com' },
    ];
    const repo: ContainerMcpServer[] = [
      { name: 'shared', type: 'http', url: 'https://repo.com' },
      { name: 'repo-only', type: 'sse', url: 'https://repo-sse.com' },
    ];
    const result = mergeMcpServers(global, repo);
    expect(result).toHaveLength(3);

    const sharedServer = result.find((s) => s.name === 'shared');
    expect(sharedServer?.type).toBe('http');
    expect(sharedServer && 'url' in sharedServer ? sharedServer.url : undefined).toBe(
      'https://repo.com'
    );

    expect(result.find((s) => s.name === 'global-only')).toBeDefined();
    expect(result.find((s) => s.name === 'repo-only')).toBeDefined();
  });
});

describe('mcpServersEqual', () => {
  const stdio = (name: string, command: string): ContainerMcpServer => ({
    name,
    type: 'stdio',
    command,
  });

  it('returns true for empty lists', () => {
    expect(mcpServersEqual([], [])).toBe(true);
  });

  it('is order-insensitive', () => {
    const a = [stdio('a', 'x'), stdio('b', 'y')];
    const b = [stdio('b', 'y'), stdio('a', 'x')];
    expect(mcpServersEqual(a, b)).toBe(true);
  });

  it('detects a changed config', () => {
    expect(mcpServersEqual([stdio('a', 'x')], [stdio('a', 'y')])).toBe(false);
  });

  it('detects added/removed servers', () => {
    expect(mcpServersEqual([stdio('a', 'x')], [stdio('a', 'x'), stdio('b', 'y')])).toBe(false);
  });
});
