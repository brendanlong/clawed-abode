import { describe, it, expect } from 'vitest';
import { parseTaskOutput } from './task-output';

describe('parseTaskOutput', () => {
  it('separates the answer from the agentId and usage trailer', () => {
    const output =
      "The answer.\n\nagentId: a1b2c3 (use SendMessage with to: 'a1b2c3')\n<usage>subagent_tokens: 10</usage>";
    expect(parseTaskOutput(output)).toEqual({ text: 'The answer.', agentId: 'a1b2c3' });
  });

  it('keeps an answer that itself mentions agentId', () => {
    const output = 'Found that `agentId: x` is parsed early.\nagentId: real123 (resume)';
    expect(parseTaskOutput(output)).toEqual({
      text: 'Found that `agentId: x` is parsed early.',
      agentId: 'real123',
    });
  });

  it('uses the last agentId line when the answer quotes one on its own line', () => {
    const output = 'Report:\nagentId: quoted (example)\nmore text\n\nagentId: real456 (resume)';
    expect(parseTaskOutput(output)).toEqual({
      text: 'Report:\nagentId: quoted (example)\nmore text',
      agentId: 'real456',
    });
  });

  it('returns the text unchanged when there is no trailer', () => {
    expect(parseTaskOutput('just text')).toEqual({ text: 'just text' });
  });
});
