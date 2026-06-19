import { describe, it, expect } from 'vitest';
import { isPlanFile } from './plan-utils';

describe('isPlanFile', () => {
  it('should detect .md files inside the default .claude/plans/ directory', () => {
    expect(isPlanFile('/home/claude/.claude/plans/dazzling-tinkering-river.md')).toBe(true);
  });

  it('should detect plan.md inside legacy .claude/projects/', () => {
    expect(isPlanFile('/home/claudeuser/.claude/projects/-workspace-clawed-abode/plan.md')).toBe(
      true
    );
  });

  it('should detect any .md file inside .claude/projects/', () => {
    expect(isPlanFile('/home/claudeuser/.claude/projects/-workspace-foo/implementation.md')).toBe(
      true
    );
  });

  it('should not detect .md files outside a plan directory', () => {
    expect(isPlanFile('/workspace/clawed-abode/README.md')).toBe(false);
  });

  it('should not detect non-.md files inside a plan directory', () => {
    expect(isPlanFile('/home/claude/.claude/plans/notes.json')).toBe(false);
    expect(isPlanFile('/home/claudeuser/.claude/projects/-workspace-foo/config.json')).toBe(false);
  });

  it('should not detect other .md files in .claude (e.g. MEMORY.md)', () => {
    expect(isPlanFile('/home/claudeuser/.claude/MEMORY.md')).toBe(false);
  });
});
