import { describe, expect, it } from 'vitest';
import {
  permissionAttentionSummary,
  permissionInputPreview,
  type PermissionRequest,
} from './permission-request';

const request = (overrides: Partial<PermissionRequest> = {}): PermissionRequest => ({
  toolUseId: 't',
  toolName: 'Bash',
  input: {},
  title: null,
  description: null,
  reason: null,
  agentId: null,
  ...overrides,
});

describe('permissionInputPreview', () => {
  it('shows the command or path a call acts on, and the whole input otherwise', () => {
    expect(permissionInputPreview({ command: 'git push', description: 'Push' })).toBe('git push');
    expect(permissionInputPreview({ file_path: '/etc/hosts', content: 'x' })).toBe('/etc/hosts');
    expect(JSON.parse(permissionInputPreview({ query: 'q' }))).toEqual({ query: 'q' });
  });
});

describe('permissionAttentionSummary', () => {
  it('uses the CLI prompt sentence, falling back to the tool name, on one line', () => {
    expect(permissionAttentionSummary(request({ title: 'Claude wants to\nrun ls' }))).toBe(
      'Permission needed: Claude wants to run ls'
    );
    expect(permissionAttentionSummary(request())).toBe(
      'Permission needed: Claude wants to use Bash'
    );
  });
});
