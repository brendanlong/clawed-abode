import { describe, it, expect } from 'vitest';
import { render } from '@testing-library/react';
import { MessageList } from './MessageList';
import type { DisplayMessage } from './messages/types';

// Builds a minimal message list around one background Explore subagent:
//   seq 0  user prompt
//   seq 1  assistant: Agent tool_use (spawn)               [top-level]
//   seq 2  system task_started (background marker)
//   seq 3  user tool_result — the async-launch ack (array content)
//   seq 4  assistant child (subagent work)                 [parent = agent]
//   seq 5  assistant main-agent text                       [top-level, interleaved]
//   seq 6  assistant child (subagent work)                 [parent = agent]
// Optionally a task_notification at seq 7 (the real finish).
const AGENT_ID = 'toolu_agent_1';

function baseMessages(opts: { withNotification?: boolean } = {}): DisplayMessage[] {
  const msgs: DisplayMessage[] = [
    {
      id: 'm0',
      type: 'user',
      sequence: 0,
      createdAt: new Date(0),
      content: { message: { content: [{ type: 'text', text: 'do the thing' }] } },
    },
    {
      id: 'm1',
      type: 'assistant',
      sequence: 1,
      createdAt: new Date(0),
      content: {
        parent_tool_use_id: null,
        message: {
          content: [
            {
              type: 'tool_use',
              id: AGENT_ID,
              name: 'Agent',
              input: { subagent_type: 'Explore', description: 'Find the buttons', prompt: 'go' },
            },
          ],
        },
      },
    },
    {
      id: 'm2',
      type: 'system',
      sequence: 2,
      createdAt: new Date(0),
      content: { subtype: 'task_started', tool_use_id: AGENT_ID, task_id: 'task_1' },
    },
    {
      id: 'm3',
      type: 'user',
      sequence: 3,
      createdAt: new Date(0),
      content: {
        message: {
          content: [
            {
              type: 'tool_result',
              tool_use_id: AGENT_ID,
              content: [{ type: 'text', text: 'Async agent launched successfully.' }],
            },
          ],
        },
      },
    },
    {
      id: 'm4',
      type: 'assistant',
      sequence: 4,
      createdAt: new Date(0),
      content: {
        parent_tool_use_id: AGENT_ID,
        message: { content: [{ type: 'text', text: 'subagent looking...' }] },
      },
    },
    {
      id: 'm5',
      type: 'assistant',
      sequence: 5,
      createdAt: new Date(0),
      content: {
        parent_tool_use_id: null,
        message: { content: [{ type: 'text', text: 'meanwhile the main agent works' }] },
      },
    },
    {
      id: 'm6',
      type: 'assistant',
      sequence: 6,
      createdAt: new Date(0),
      content: {
        parent_tool_use_id: AGENT_ID,
        message: { content: [{ type: 'text', text: 'subagent found it' }] },
      },
    },
  ];
  if (opts.withNotification) {
    msgs.push({
      id: 'm7',
      type: 'system',
      sequence: 7,
      createdAt: new Date(0),
      content: {
        subtype: 'task_notification',
        tool_use_id: AGENT_ID,
        task_id: 'task_1',
        status: 'completed',
      },
    });
  }
  return msgs;
}

function renderList(messages: DisplayMessage[], isSessionRunning: boolean) {
  return render(
    <MessageList
      messages={messages}
      isLoading={false}
      hasMore={false}
      onLoadMore={() => {}}
      isSessionRunning={isSessionRunning}
    />
  );
}

describe('MessageList timestamps', () => {
  it('renders a timestamp on the top-level user prompt but not on subagent rows', () => {
    const { container } = renderList(baseMessages({ withNotification: true }), false);
    const times = Array.from(container.querySelectorAll('time'));
    expect(times).toHaveLength(1);
    expect(container.querySelector('[data-message-id="m0"] time')).not.toBeNull();
  });
});

describe('MessageList subagent relocation', () => {
  it('pins a running background subagent and leaves a breadcrumb at the spawn point', () => {
    const { container } = renderList(baseMessages(), true);

    // Breadcrumb at spawn, no full box inline there.
    expect(container.textContent).toContain('Subagent started');

    // Pinned section with the live box (Running).
    const pinned = container.querySelector('[data-pinned-subagents]');
    expect(pinned).not.toBeNull();
    expect(pinned!.textContent).toContain('Running subagent');
    expect(pinned!.textContent).toContain('Running...');

    // Not settled into the transcript yet.
    expect(container.querySelector('[data-subagent-box]')).toBeNull();
  });

  it('settles a finished background subagent to its last-child position when the session is idle', () => {
    const { container } = renderList(baseMessages(), false);

    // Breadcrumb remains at spawn.
    expect(container.textContent).toContain('Subagent started');

    // Relocated box exists (at the finish position) and reads Done, not Running.
    const box = container.querySelector('[data-subagent-box]');
    expect(box).not.toBeNull();
    expect(box!.textContent).toContain('Done');

    // Nothing pinned once idle.
    expect(container.querySelector('[data-pinned-subagents]')).toBeNull();
  });

  it('uses a task_notification as the finish point even while the session is live', () => {
    const { container } = renderList(baseMessages({ withNotification: true }), true);

    // A terminal notification means it settled: box in transcript, nothing pinned.
    expect(container.querySelector('[data-subagent-box]')).not.toBeNull();
    expect(container.querySelector('[data-pinned-subagents]')).toBeNull();
    expect(container.textContent).toContain('Subagent started');
  });
});

describe('MessageList older-page loader', () => {
  function renderLoader(opts: { hasMore: boolean; isLoading: boolean }) {
    return render(
      <MessageList
        messages={baseMessages()}
        isLoading={opts.isLoading}
        hasMore={opts.hasMore}
        onLoadMore={() => {}}
      />
    );
  }

  // Scrolling back at speed pins the container at scrollTop 0, where scroll
  // anchoring cannot compensate for a height change above the messages. The slot
  // must therefore stay in the layout across the whole fetch cycle — only the
  // spinner inside it may come and go.
  it('keeps the loader slot mounted whether or not a page is in flight', () => {
    for (const isLoading of [true, false]) {
      const { container } = renderLoader({ hasMore: true, isLoading });
      expect(container.querySelector('[data-older-messages-loader]')).not.toBeNull();
    }
  });

  it('shows the spinner only while a page is in flight', () => {
    const loading = renderLoader({ hasMore: true, isLoading: true });
    expect(loading.container.querySelector('[data-older-messages-loader] svg')).not.toBeNull();

    const idle = renderLoader({ hasMore: true, isLoading: false });
    expect(idle.container.querySelector('[data-older-messages-loader] svg')).toBeNull();
  });

  it('drops the slot once there are no older pages left to fetch', () => {
    const { container } = renderLoader({ hasMore: false, isLoading: false });
    expect(container.querySelector('[data-older-messages-loader]')).toBeNull();
  });
});
