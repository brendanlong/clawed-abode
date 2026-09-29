import { describe, it, expect } from 'vitest';
import { mergeByName, mcpServersEqual } from './settings-merger';
import type { ResolvedEnvVar, ResolvedMcpServer } from '@/lib/settings-types';

describe('mergeByName', () => {
  it('should return empty array when both inputs are empty', () => {
    expect(mergeByName([], [])).toEqual([]);
  });

  it('should return global env vars when no repo vars exist', () => {
    const global: ResolvedEnvVar[] = [
      { name: 'API_KEY', value: 'global-key' },
      { name: 'DEBUG', value: 'true' },
    ];
    const result = mergeByName(global, []);
    expect(result).toEqual(global);
  });

  it('should return repo env vars when no global vars exist', () => {
    const repo: ResolvedEnvVar[] = [{ name: 'REPO_VAR', value: 'repo-value' }];
    const result = mergeByName([], repo);
    expect(result).toEqual(repo);
  });

  it('should merge global and repo env vars', () => {
    const global: ResolvedEnvVar[] = [{ name: 'GLOBAL_VAR', value: 'global' }];
    const repo: ResolvedEnvVar[] = [{ name: 'REPO_VAR', value: 'repo' }];
    const result = mergeByName(global, repo);
    expect(result).toHaveLength(2);
    expect(result).toContainEqual({ name: 'GLOBAL_VAR', value: 'global' });
    expect(result).toContainEqual({ name: 'REPO_VAR', value: 'repo' });
  });

  it('should let per-repo env vars override global ones with the same name', () => {
    const global: ResolvedEnvVar[] = [
      { name: 'API_KEY', value: 'global-key' },
      { name: 'SHARED', value: 'global-shared' },
    ];
    const repo: ResolvedEnvVar[] = [
      { name: 'SHARED', value: 'repo-shared' },
      { name: 'REPO_ONLY', value: 'repo' },
    ];
    const result = mergeByName(global, repo);
    expect(result).toHaveLength(3);
    expect(result).toContainEqual({ name: 'API_KEY', value: 'global-key' });
    expect(result).toContainEqual({ name: 'SHARED', value: 'repo-shared' });
    expect(result).toContainEqual({ name: 'REPO_ONLY', value: 'repo' });
  });
});

describe('mcpServersEqual', () => {
  const stdio = (name: string, command: string): ResolvedMcpServer => ({
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
