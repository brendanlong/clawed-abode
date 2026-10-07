import { describe, it, expect } from 'vitest';
import {
  ATTENTION_SUMMARY_MAX_LENGTH,
  attentionSummarySchema,
  interactiveToolAttentionSummary,
  toAttentionSummary,
} from './session-attention';

describe('attentionSummarySchema', () => {
  it('accepts a trimmed single line', () => {
    expect(attentionSummarySchema.parse('  PR #12 ready  ')).toBe('PR #12 ready');
  });

  it('rejects multi-line, empty, and overlong summaries', () => {
    expect(attentionSummarySchema.safeParse('a\nb').success).toBe(false);
    expect(attentionSummarySchema.safeParse('   ').success).toBe(false);
    expect(
      attentionSummarySchema.safeParse('x'.repeat(ATTENTION_SUMMARY_MAX_LENGTH + 1)).success
    ).toBe(false);
  });
});

describe('toAttentionSummary', () => {
  it('collapses whitespace and newlines into one line', () => {
    expect(toAttentionSummary('Which\n\n  option?\t', 'fallback')).toBe('Which option?');
  });

  it('truncates to a summary the schema accepts', () => {
    const summary = toAttentionSummary('word '.repeat(100), 'fallback');
    expect(summary.endsWith('…')).toBe(true);
    expect(attentionSummarySchema.parse(summary)).toBe(summary);
  });

  it('falls back for blank text', () => {
    expect(toAttentionSummary(' \n ', 'fallback')).toBe('fallback');
  });
});

describe('interactiveToolAttentionSummary', () => {
  it('uses the first question of an AskUserQuestion', () => {
    const input = { questions: [{ question: 'Which DB?', header: 'DB' }, { question: 'Other?' }] };
    expect(interactiveToolAttentionSummary('AskUserQuestion', input)).toBe('Which DB?');
  });

  it('falls back when AskUserQuestion input is malformed', () => {
    expect(interactiveToolAttentionSummary('AskUserQuestion', { questions: 'nope' })).toBe(
      'Claude has a question for you'
    );
  });

  it('announces a plan for ExitPlanMode', () => {
    expect(interactiveToolAttentionSummary('ExitPlanMode', {})).toBe('Plan ready for review');
  });

  it('is null for tools that do not wait on the user', () => {
    expect(interactiveToolAttentionSummary('Bash', { command: 'ls' })).toBeNull();
  });
});
