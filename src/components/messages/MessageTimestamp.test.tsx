import { describe, it, expect } from 'vitest';
import { render } from '@testing-library/react';
import { MessageBubble } from './MessageBubble';
import { SubagentTranscript } from './SubagentTranscript';

const createdAt = new Date(2024, 0, 15, 9, 30);

function timeElements(container: HTMLElement) {
  return Array.from(container.querySelectorAll('time'));
}

describe('turn-boundary timestamps', () => {
  it('shows one under a user prompt', () => {
    const { container } = render(
      <MessageBubble message={{ id: 'u1', type: 'user', content: { content: 'hi' }, createdAt }} />
    );
    const [time] = timeElements(container);
    expect(time).toBeDefined();
    expect(time.getAttribute('dateTime')).toBe(createdAt.toISOString());
    // Not today, so the compact form includes the date.
    expect(time.textContent).toMatch(/Jan 15/);
  });

  it('shows one on the result row and on an interrupt marker', () => {
    const { container } = render(
      <>
        <MessageBubble
          message={{
            id: 'r1',
            type: 'result',
            content: { type: 'result', subtype: 'success', session_id: 's1', num_turns: 1 },
            createdAt,
          }}
        />
        <MessageBubble
          message={{
            id: 'i1',
            type: 'user',
            content: { type: 'user', subtype: 'interrupt', content: 'Interrupted' },
            createdAt,
          }}
        />
      </>
    );
    expect(timeElements(container)).toHaveLength(2);
  });

  it('does not show one on assistant messages', () => {
    const { container } = render(
      <MessageBubble
        message={{
          id: 'a1',
          type: 'assistant',
          content: { message: { content: [{ type: 'text', text: 'hello' }] } },
          createdAt,
        }}
      />
    );
    expect(timeElements(container)).toHaveLength(0);
  });

  it('does not show one inside a subagent transcript', () => {
    const { container } = render(
      <SubagentTranscript
        messages={[
          { id: 'u1', type: 'user', sequence: 1, content: { content: 'go' }, createdAt },
          {
            id: 'r1',
            type: 'result',
            sequence: 2,
            content: { type: 'result', subtype: 'success', session_id: 's1', num_turns: 1 },
            createdAt,
          },
        ]}
        toolResults={new Map()}
        pairedMessageIds={new Set()}
      />
    );
    expect(container.textContent).toContain('go');
    expect(timeElements(container)).toHaveLength(0);
  });
});
