import { describe, it, expect } from 'vitest';
import { isPlanFile, reconstructPlansByToolUseId, type PlanEvent } from './plan-utils';

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

describe('reconstructPlansByToolUseId', () => {
  const FILE_A = '/home/claude/.claude/plans/plan-a.md';
  const FILE_B = '/home/claude/.claude/plans/plan-b.md';

  it('ties a single plan to its ExitPlanMode call', () => {
    const events: PlanEvent[] = [
      { kind: 'write', sequence: 1, filePath: FILE_A, content: '# Plan A' },
      { kind: 'exit', sequence: 2, toolUseId: 'exit-1' },
    ];
    expect(reconstructPlansByToolUseId(events)).toEqual(new Map([['exit-1', '# Plan A']]));
  });

  it('applies edits to a plan before its approval', () => {
    const events: PlanEvent[] = [
      { kind: 'write', sequence: 1, filePath: FILE_A, content: 'use Redis' },
      { kind: 'edit', sequence: 2, filePath: FILE_A, oldString: 'Redis', newString: 'Postgres' },
      { kind: 'exit', sequence: 3, toolUseId: 'exit-1' },
    ];
    expect(reconstructPlansByToolUseId(events).get('exit-1')).toBe('use Postgres');
  });

  it('keeps separate plans separate across multiple plan files', () => {
    const events: PlanEvent[] = [
      { kind: 'write', sequence: 1, filePath: FILE_A, content: '# Plan A' },
      { kind: 'exit', sequence: 2, toolUseId: 'exit-a' },
      { kind: 'write', sequence: 3, filePath: FILE_B, content: '# Plan B' },
      { kind: 'exit', sequence: 4, toolUseId: 'exit-b' },
    ];
    const result = reconstructPlansByToolUseId(events);
    // The earlier approval must NOT be overwritten by the later plan.
    expect(result.get('exit-a')).toBe('# Plan A');
    expect(result.get('exit-b')).toBe('# Plan B');
  });

  it('does not let an edit to one plan file corrupt another', () => {
    const events: PlanEvent[] = [
      { kind: 'write', sequence: 1, filePath: FILE_A, content: 'shared word here' },
      { kind: 'write', sequence: 2, filePath: FILE_B, content: 'shared word elsewhere' },
      // Edit targets FILE_A; must not touch FILE_B's content.
      { kind: 'edit', sequence: 3, filePath: FILE_A, oldString: 'shared', newString: 'unique' },
      { kind: 'exit', sequence: 4, toolUseId: 'exit-b' },
    ];
    // exit-b ties to the most-recently-touched file (FILE_A after the edit),
    // and FILE_B's content remains intact regardless.
    const result = reconstructPlansByToolUseId(events);
    expect(result.get('exit-b')).toBe('unique word here');
  });

  it('handles a revised plan to the same file (each exit reflects its moment)', () => {
    const events: PlanEvent[] = [
      { kind: 'write', sequence: 1, filePath: FILE_A, content: 'v1' },
      { kind: 'exit', sequence: 2, toolUseId: 'exit-1' },
      { kind: 'write', sequence: 3, filePath: FILE_A, content: 'v2' },
      { kind: 'exit', sequence: 4, toolUseId: 'exit-2' },
    ];
    const result = reconstructPlansByToolUseId(events);
    expect(result.get('exit-1')).toBe('v1');
    expect(result.get('exit-2')).toBe('v2');
  });

  it('omits an ExitPlanMode with no preceding plan content', () => {
    const events: PlanEvent[] = [{ kind: 'exit', sequence: 1, toolUseId: 'exit-1' }];
    expect(reconstructPlansByToolUseId(events).has('exit-1')).toBe(false);
  });

  it('sorts by sequence regardless of input order', () => {
    const events: PlanEvent[] = [
      { kind: 'exit', sequence: 3, toolUseId: 'exit-1' },
      { kind: 'write', sequence: 1, filePath: FILE_A, content: 'early' },
      { kind: 'edit', sequence: 2, filePath: FILE_A, oldString: 'early', newString: 'late' },
    ];
    expect(reconstructPlansByToolUseId(events).get('exit-1')).toBe('late');
  });
});
