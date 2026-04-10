import { describe, it, expect } from 'vitest';
import { expandHookTemplate } from './shutdown-hooks';

describe('expandHookTemplate', () => {
  const baseSession = {
    id: 'test-session-id',
    name: 'Fix login bug',
    repoUrl: 'https://github.com/brendanlong/clawed-abode.git',
    branch: 'main',
    repoPath: 'clawed-abode',
  };

  it('expands {{session.name}}', () => {
    const result = expandHookTemplate('Session: {{session.name}}', baseSession);
    expect(result).toBe('Session: Fix login bug');
  });

  it('expands {{session.repo}} from repoUrl', () => {
    const result = expandHookTemplate('Repo: {{session.repo}}', baseSession);
    expect(result).toBe('Repo: brendanlong/clawed-abode');
  });

  it('expands {{session.repo}} to "No Repository" when repoUrl is null', () => {
    const session = { ...baseSession, repoUrl: null };
    const result = expandHookTemplate('Repo: {{session.repo}}', session);
    expect(result).toBe('Repo: No Repository');
  });

  it('expands {{session.branch}}', () => {
    const result = expandHookTemplate('Branch: {{session.branch}}', baseSession);
    expect(result).toBe('Branch: main');
  });

  it('expands {{session.branch}} to empty string when null', () => {
    const session = { ...baseSession, branch: null };
    const result = expandHookTemplate('Branch: {{session.branch}}', session);
    expect(result).toBe('Branch: ');
  });

  it('expands {{date}} to YYYY-MM-DD format', () => {
    const result = expandHookTemplate('Date: {{date}}', baseSession);
    // Match YYYY-MM-DD format
    expect(result).toMatch(/^Date: \d{4}-\d{2}-\d{2}$/);
  });

  it('expands multiple variables in a single template', () => {
    const template =
      'Write a journal entry for {{session.name}} ({{session.repo}}) on {{date}} to ~/wiki/content/journals/{{date}}--{{session.name}}.md';
    const result = expandHookTemplate(template, baseSession);
    expect(result).toContain('Fix login bug');
    expect(result).toContain('brendanlong/clawed-abode');
    // Date should appear twice
    const dateMatches = result.match(/\d{4}-\d{2}-\d{2}/g);
    expect(dateMatches).toHaveLength(2);
    expect(dateMatches![0]).toBe(dateMatches![1]);
  });

  it('returns template unchanged when no variables present', () => {
    const template = 'This is a plain prompt with no variables.';
    const result = expandHookTemplate(template, baseSession);
    expect(result).toBe(template);
  });

  it('handles repeated occurrences of the same variable', () => {
    const template = '{{session.name}} and {{session.name}} again';
    const result = expandHookTemplate(template, baseSession);
    expect(result).toBe('Fix login bug and Fix login bug again');
  });
});
