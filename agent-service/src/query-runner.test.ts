import { describe, it, expect } from 'vitest';
import { mergeSlashCommands } from './query-runner.js';

describe('mergeSlashCommands', () => {
  it('returns existing commands when slash_commands is empty', () => {
    const existing = [{ name: 'migration', description: 'Run migrations', argumentHint: '<file>' }];
    const result = mergeSlashCommands(existing, []);
    expect(result).toEqual(existing);
  });

  it('returns synthesized commands when existing is empty', () => {
    const result = mergeSlashCommands([], ['compact', 'cost', 'context']);
    expect(result).toEqual([
      { name: 'compact', description: '', argumentHint: '' },
      { name: 'cost', description: '', argumentHint: '' },
      { name: 'context', description: '', argumentHint: '' },
    ]);
  });

  it('merges without duplicating commands already in existing', () => {
    const existing = [{ name: 'migration', description: 'Run migrations', argumentHint: '<file>' }];
    const slashCommands = ['migration', 'compact', 'cost'];
    const result = mergeSlashCommands(existing, slashCommands);
    expect(result).toEqual([
      { name: 'migration', description: 'Run migrations', argumentHint: '<file>' },
      { name: 'compact', description: '', argumentHint: '' },
      { name: 'cost', description: '', argumentHint: '' },
    ]);
  });

  it('preserves rich metadata for existing commands', () => {
    const existing = [
      { name: 'migration', description: 'Run migrations', argumentHint: '<file>' },
      { name: 'review', description: 'Review code', argumentHint: '' },
    ];
    const slashCommands = ['migration', 'review', 'compact'];
    const result = mergeSlashCommands(existing, slashCommands);
    expect(result[0]).toEqual({
      name: 'migration',
      description: 'Run migrations',
      argumentHint: '<file>',
    });
    expect(result[1]).toEqual({
      name: 'review',
      description: 'Review code',
      argumentHint: '',
    });
    expect(result[2]).toEqual({
      name: 'compact',
      description: '',
      argumentHint: '',
    });
  });

  it('returns both empty when both inputs are empty', () => {
    const result = mergeSlashCommands([], []);
    expect(result).toEqual([]);
  });

  it('does not modify the original existing commands array', () => {
    const existing = [{ name: 'migration', description: 'Run migrations', argumentHint: '<file>' }];
    const original = [...existing];
    mergeSlashCommands(existing, ['compact']);
    expect(existing).toEqual(original);
  });

  it('handles real-world scenario: skills subset vs full slash_commands', () => {
    // initializationResult().commands returns only skills (rich objects)
    const skills = [{ name: 'migration', description: 'Migrate database', argumentHint: '' }];

    // System init message contains all slash_commands (bare strings)
    const allSlashCommands = [
      'migration',
      'compact',
      'context',
      'cost',
      'init',
      'pr-comments',
      'release-notes',
      'review',
      'security-review',
    ];

    const result = mergeSlashCommands(skills, allSlashCommands);

    // Should have all 9 commands
    expect(result).toHaveLength(9);

    // Skills should preserve rich metadata
    expect(result[0]).toEqual({
      name: 'migration',
      description: 'Migrate database',
      argumentHint: '',
    });

    // Non-skill commands should have empty descriptions
    const nonSkillNames = allSlashCommands.filter((n) => n !== 'migration');
    for (const name of nonSkillNames) {
      const cmd = result.find((c) => c.name === name);
      expect(cmd).toBeDefined();
      expect(cmd?.description).toBe('');
      expect(cmd?.argumentHint).toBe('');
    }
  });
});
