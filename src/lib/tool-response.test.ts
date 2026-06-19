import { describe, it, expect } from 'vitest';
import {
  summarizeToolResponse,
  formatToolResponsePrompt,
  buildSyntheticToolResultContent,
  type ToolResponse,
} from './tool-response';
import { UserContentSchema } from './claude-messages';

describe('summarizeToolResponse', () => {
  it('joins question answer values', () => {
    const response: ToolResponse = {
      kind: 'questions',
      answers: { 'Which approach?': 'Option A', 'Use TypeScript?': 'Yes' },
    };
    expect(summarizeToolResponse(response)).toBe('Option A, Yes');
  });

  it('handles empty question answers', () => {
    expect(summarizeToolResponse({ kind: 'questions', answers: {} })).toBe('No selection');
    expect(summarizeToolResponse({ kind: 'questions', answers: { q: '  ' } })).toBe('No selection');
  });

  it('summarizes plan approval', () => {
    expect(summarizeToolResponse({ kind: 'plan', approve: true })).toBe('Plan approved');
  });

  it('summarizes plan rejection with and without feedback', () => {
    expect(summarizeToolResponse({ kind: 'plan', approve: false })).toBe('Changes requested');
    expect(summarizeToolResponse({ kind: 'plan', approve: false, feedback: 'use a queue' })).toBe(
      'Changes requested: use a queue'
    );
  });
});

describe('formatToolResponsePrompt', () => {
  it('formats question answers as labeled blocks', () => {
    const prompt = formatToolResponsePrompt({
      kind: 'questions',
      answers: { 'Which approach?': 'Option A', 'Use TypeScript?': 'Yes' },
    });
    expect(prompt).toContain('Here are my answers to your questions:');
    expect(prompt).toContain('**Which approach?**\nOption A');
    expect(prompt).toContain('**Use TypeScript?**\nYes');
  });

  it('skips blank answers and degrades gracefully when none remain', () => {
    expect(formatToolResponsePrompt({ kind: 'questions', answers: { q: '' } })).toBe(
      'I have no answer to your questions; please use your best judgment.'
    );
  });

  it('formats plan approval, with optional notes', () => {
    expect(formatToolResponsePrompt({ kind: 'plan', approve: true })).toBe(
      'I approve this plan. Please go ahead and implement it.'
    );
    expect(
      formatToolResponsePrompt({ kind: 'plan', approve: true, feedback: 'ship it' })
    ).toContain('Additional notes:\nship it');
  });

  it('formats plan rejection, with optional feedback', () => {
    expect(formatToolResponsePrompt({ kind: 'plan', approve: false })).toBe(
      "I'd like you to revise the plan before implementing it."
    );
    expect(formatToolResponsePrompt({ kind: 'plan', approve: false, feedback: 'too risky' })).toBe(
      'Please revise the plan before implementing it. too risky'
    );
  });
});

describe('buildSyntheticToolResultContent', () => {
  it('produces a valid UserContent tool_result that pairs by tool_use_id', () => {
    const content = buildSyntheticToolResultContent({
      sessionId: 'session-1',
      toolUseId: 'toolu_abc',
      uuid: 'uuid-1',
      text: 'Option A',
    });

    // Must parse against the same schema the message list uses, so the UI
    // pairs the dangling tool_use exactly like a real SDK result.
    const parsed = UserContentSchema.safeParse(content);
    expect(parsed.success).toBe(true);

    const block = content.message.content[0];
    expect(block).toMatchObject({
      type: 'tool_result',
      tool_use_id: 'toolu_abc',
      content: 'Option A',
      is_error: false,
    });
  });
});
