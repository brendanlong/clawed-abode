import { describe, it, expect } from 'vitest';
import { buildEditorFolderUrl, buildEditorFileUrl } from './editor-url';

describe('buildEditorFolderUrl', () => {
  it('returns null when no base URL is configured', () => {
    expect(buildEditorFolderUrl(undefined, '/home/user/worktrees/abc/repo')).toBeNull();
    expect(buildEditorFolderUrl(null, '/home/user/worktrees/abc/repo')).toBeNull();
    expect(buildEditorFolderUrl('', '/home/user/worktrees/abc/repo')).toBeNull();
    expect(buildEditorFolderUrl('   ', '/home/user/worktrees/abc/repo')).toBeNull();
  });

  it('builds a folder deep link', () => {
    expect(buildEditorFolderUrl('https://host.ts.net:8443', '/home/user/worktrees/abc/repo')).toBe(
      'https://host.ts.net:8443/?folder=%2Fhome%2Fuser%2Fworktrees%2Fabc%2Frepo'
    );
  });

  it('strips trailing slashes from the base URL', () => {
    expect(buildEditorFolderUrl('https://host.ts.net:8443///', '/tmp/x')).toBe(
      'https://host.ts.net:8443/?folder=%2Ftmp%2Fx'
    );
  });

  it('supports a relative base path', () => {
    expect(buildEditorFolderUrl('/editor', '/tmp/x')).toBe('/editor/?folder=%2Ftmp%2Fx');
  });

  it('percent-encodes spaces and special characters in the path', () => {
    expect(buildEditorFolderUrl('https://host', '/tmp/my repo/a&b')).toBe(
      'https://host/?folder=%2Ftmp%2Fmy%20repo%2Fa%26b'
    );
  });
});

describe('buildEditorFileUrl', () => {
  it('returns null when no base URL is configured', () => {
    expect(buildEditorFileUrl(undefined, '/ws/repo', '/ws/repo/src/a.ts')).toBeNull();
    expect(buildEditorFileUrl('', '/ws/repo', '/ws/repo/src/a.ts')).toBeNull();
    expect(buildEditorFileUrl('   ', '/ws/repo', '/ws/repo/src/a.ts')).toBeNull();
  });

  it('returns null when the file path is not absolute', () => {
    expect(buildEditorFileUrl('https://host', '/ws/repo', 'Unknown file')).toBeNull();
    expect(buildEditorFileUrl('https://host', '/ws/repo', 'src/a.ts')).toBeNull();
  });

  it('builds a payload openFile link with the code-server remote authority', () => {
    const url = buildEditorFileUrl('https://host', '/ws/repo', '/ws/repo/src/a.ts');
    // folder param opens the workspace; payload opens the specific file.
    expect(url).toBe(
      'https://host/?folder=%2Fws%2Frepo&payload=' +
        encodeURIComponent('[["openFile","vscode-remote://remote/ws/repo/src/a.ts"]]')
    );
  });

  it('strips trailing slashes from the base URL', () => {
    const url = buildEditorFileUrl('https://host///', '/ws', '/ws/a.ts');
    expect(url?.startsWith('https://host/?folder=')).toBe(true);
  });

  it('percent-encodes path segments while preserving separators', () => {
    const url = buildEditorFileUrl('https://host', '/ws', '/ws/my dir/a&b.ts');
    // Spaces and & are encoded inside the URI, slashes are preserved.
    const expectedUri = 'vscode-remote://remote/ws/my%20dir/a%26b.ts';
    expect(url).toBe(
      'https://host/?folder=%2Fws&payload=' + encodeURIComponent(`[["openFile","${expectedUri}"]]`)
    );
  });

  it('can open a file outside the workspace folder', () => {
    const url = buildEditorFileUrl('https://host', '/ws/repo', '/etc/hosts');
    expect(url).toContain(encodeURIComponent('[["openFile","vscode-remote://remote/etc/hosts"]]'));
    expect(url).toContain('folder=%2Fws%2Frepo');
  });
});
