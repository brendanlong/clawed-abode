import { describe, it, expect } from 'vitest';
import { buildEditorUrl } from './editor-url';

describe('buildEditorUrl', () => {
  it('returns null when no base URL is configured', () => {
    expect(buildEditorUrl(undefined, '/home/user/worktrees/abc/repo')).toBeNull();
    expect(buildEditorUrl(null, '/home/user/worktrees/abc/repo')).toBeNull();
    expect(buildEditorUrl('', '/home/user/worktrees/abc/repo')).toBeNull();
    expect(buildEditorUrl('   ', '/home/user/worktrees/abc/repo')).toBeNull();
  });

  it('builds a folder deep link', () => {
    expect(buildEditorUrl('https://host.ts.net:8443', '/home/user/worktrees/abc/repo')).toBe(
      'https://host.ts.net:8443/?folder=%2Fhome%2Fuser%2Fworktrees%2Fabc%2Frepo'
    );
  });

  it('strips trailing slashes from the base URL', () => {
    expect(buildEditorUrl('https://host.ts.net:8443///', '/tmp/x')).toBe(
      'https://host.ts.net:8443/?folder=%2Ftmp%2Fx'
    );
  });

  it('supports a relative base path', () => {
    expect(buildEditorUrl('/editor', '/tmp/x')).toBe('/editor/?folder=%2Ftmp%2Fx');
  });

  it('percent-encodes spaces and special characters in the path', () => {
    expect(buildEditorUrl('https://host', '/tmp/my repo/a&b')).toBe(
      'https://host/?folder=%2Ftmp%2Fmy%20repo%2Fa%26b'
    );
  });
});
