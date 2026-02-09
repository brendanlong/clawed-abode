import { describe, it, expect } from 'vitest';
import { isPlanFile } from './plan-utils';

describe('isPlanFile', () => {
  it('should detect plan.md inside .claude/projects/', () => {
    expect(isPlanFile('/home/claudeuser/.claude/projects/-workspace-clawed-abode/plan.md')).toBe(
      true
    );
  });

  it('should detect any .md file inside .claude/projects/', () => {
    expect(isPlanFile('/home/claudeuser/.claude/projects/-workspace-foo/implementation.md')).toBe(
      true
    );
  });

  it('should not detect .md files outside .claude/projects/', () => {
    expect(isPlanFile('/workspace/clawed-abode/README.md')).toBe(false);
  });

  it('should not detect non-.md files inside .claude/projects/', () => {
    expect(isPlanFile('/home/claudeuser/.claude/projects/-workspace-foo/config.json')).toBe(false);
  });

  it('should not detect files in .claude but not in projects/', () => {
    expect(isPlanFile('/home/claudeuser/.claude/MEMORY.md')).toBe(false);
  });
});
