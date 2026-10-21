import { describe, it, expect, vi } from 'vitest';
import type { ReactElement } from 'react';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { observable } from '@trpc/server/observable';
import { TRPCClientError, type TRPCLink } from '@trpc/client';
import { trpc } from '@/lib/trpc';
import type { AppRouter } from '@/server/routers';
import { projectMessageContent } from '@/lib/tool-result';
import { MessageList } from './MessageList';
import type { DisplayMessage } from './messages/types';

/** How many times each markdown text has rendered, to tell which bubbles re-rendered. */
const markdownRenders = vi.hoisted(() => new Map<string, number>());

vi.mock('@/components/MarkdownContent', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/components/MarkdownContent')>();
  return {
    ...actual,
    MarkdownContent: (props: Parameters<typeof actual.MarkdownContent>[0]) => {
      markdownRenders.set(props.content, (markdownRenders.get(props.content) ?? 0) + 1);
      return actual.MarkdownContent(props);
    },
  };
});

/**
 * Render inside a tRPC provider whose fake server answers `claude.getToolResult`
 * from `bodies` (keyed by tool_use id), recording each request.
 */
function renderWithTrpc(ui: ReactElement, bodies: Record<string, string> = {}) {
  const requests: { messageId: string; toolUseId: string }[] = [];
  const link: TRPCLink<AppRouter> = () => {
    return ({ op }) =>
      observable((observer) => {
        if (op.path === 'claude.getToolResult') {
          const input = op.input as { messageId: string; toolUseId: string };
          requests.push({ messageId: input.messageId, toolUseId: input.toolUseId });
          const text = bodies[input.toolUseId];
          if (text === undefined) {
            observer.error(
              TRPCClientError.from({
                error: {
                  code: -32004,
                  message: 'Tool result not found',
                  data: { code: 'NOT_FOUND' },
                },
              })
            );
          } else {
            observer.next({ result: { type: 'data', data: { text } } });
            observer.complete();
          }
        } else {
          observer.error(TRPCClientError.from(new Error(`unexpected request: ${op.path}`)));
        }
        return () => {};
      });
  };
  const client = trpc.createClient({ links: [link] });
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const wrap = (node: ReactElement) => (
    <trpc.Provider client={client} queryClient={queryClient}>
      <QueryClientProvider client={queryClient}>{node}</QueryClientProvider>
    </trpc.Provider>
  );
  const view = render(wrap(ui));
  return { ...view, rerender: (next: ReactElement) => view.rerender(wrap(next)), requests };
}

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
  return renderWithTrpc(
    <MessageList
      sessionId="session-1"
      messages={messages}
      isLoading={false}
      hasMore={false}
      loadFailed={false}
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

describe('MessageList refusal fallback', () => {
  // In prod the redo sometimes starts before the banner arrives, as here.
  const messages: DisplayMessage[] = [
    {
      id: 'm1',
      type: 'assistant',
      sequence: 1,
      createdAt: new Date(0),
      content: { uuid: 'u1', message: { content: [{ type: 'text', text: 'fable attempt' }] } },
    },
    {
      id: 'm2',
      type: 'assistant',
      sequence: 2,
      createdAt: new Date(0),
      content: { uuid: 'u2', message: { content: [{ type: 'text', text: 'opus redo' }] } },
    },
    {
      id: 'm3',
      type: 'system',
      sequence: 3,
      createdAt: new Date(0),
      content: {
        subtype: 'model_refusal_fallback',
        original_model: 'claude-fable-5',
        fallback_model: 'claude-opus-4-8',
        retracted_message_uuids: ['u1'],
      },
    },
  ];

  it('folds the retracted attempt under the banner, collapsed until expanded', async () => {
    const { container } = renderList(messages, false);

    // Not a top-level row, and hidden until expanded.
    expect(container.querySelector('[data-message-id="m1"]')).toBeNull();
    expect(container.textContent).not.toContain('fable attempt');
    expect(container.textContent).toContain('opus redo');

    await userEvent.click(screen.getByText("Show claude-fable-5's earlier attempt"));

    const retracted = container.querySelector('[data-retracted-messages]');
    expect(retracted?.textContent).toContain('fable attempt');
    expect(retracted?.textContent).toContain('Any tool calls below still ran');
    expect(screen.getByText("Hide claude-fable-5's earlier attempt")).toBeInTheDocument();
  });

  it('offers no expander when none of the retracted messages are loaded', () => {
    renderList(messages.slice(1), false);
    expect(screen.getByText('Model switched after refusal')).toBeInTheDocument();
    expect(screen.queryByText(/earlier attempt/)).toBeNull();
  });
});

describe('MessageList older-page loader', () => {
  function renderLoader(opts: { hasMore: boolean; isLoading: boolean }) {
    return renderWithTrpc(
      <MessageList
        sessionId="session-1"
        messages={baseMessages()}
        isLoading={opts.isLoading}
        hasMore={opts.hasMore}
        loadFailed={false}
        onLoadMore={() => {}}
      />
    );
  }

  // The slot must hold its height across the whole fetch cycle; MessageList.tsx
  // explains why. jsdom has no layout, so assert the class that sets it.
  it.each([true, false])('reserves the slot at a fixed height (isLoading=%s)', (isLoading) => {
    const { container } = renderLoader({ hasMore: true, isLoading });
    const slot = container.querySelector('[data-older-messages-loader]');
    expect(slot).not.toBeNull();
    expect(slot!.className).toContain('h-12');
  });

  it('shows the spinner only while a page is in flight', () => {
    const loading = renderLoader({ hasMore: true, isLoading: true });
    expect(loading.container.querySelector('[data-older-messages-loader] > svg')).not.toBeNull();

    const idle = renderLoader({ hasMore: true, isLoading: false });
    expect(idle.container.querySelector('[data-older-messages-loader] > svg')).toBeNull();
  });

  it('drops the slot once there are no older pages left to fetch', () => {
    const { container } = renderLoader({ hasMore: false, isLoading: false });
    expect(container.querySelector('[data-older-messages-loader]')).toBeNull();
  });
});

describe('MessageList lazy tool-result bodies', () => {
  const READ_BODY = Array.from(
    { length: 300 },
    (_, i) => `${String(i + 1).padStart(6)}→alpha${i + 1}`
  ).join('\n');
  const GREP_BODY = Array.from({ length: 200 }, (_, i) => `src/file${i}.ts`).join('\n');
  const REPORT = `The final report. ${'detail '.repeat(300)}`;
  const BODIES: Record<string, string> = { r1: READ_BODY, g1: GREP_BODY, fg1: REPORT };

  const at = (sequence: number, type: string, content: unknown): DisplayMessage => ({
    id: `m${sequence}`,
    type,
    sequence,
    createdAt: new Date(0),
    // What the server sends: the stored content, projected for clients.
    content: projectMessageContent(content),
  });
  const call = (seq: number, id: string, name: string, input: unknown, parent?: string) =>
    at(seq, 'assistant', {
      parent_tool_use_id: parent ?? null,
      message: { content: [{ type: 'tool_use', id, name, input }] },
    });
  const result = (seq: number, id: string, text: string, isError = false, parent?: string) =>
    at(seq, 'user', {
      parent_tool_use_id: parent ?? null,
      tool_use_result: { stdout: text },
      message: {
        content: [{ type: 'tool_result', tool_use_id: id, content: text, is_error: isError }],
      },
    });

  const messages: DisplayMessage[] = [
    at(0, 'user', { content: 'look around' }),
    call(1, 'r1', 'Read', { file_path: '/repo/a.ts' }),
    result(2, 'r1', READ_BODY),
    call(3, 'b1', 'Bash', { command: 'false' }),
    result(4, 'b1', 'command failed', true),
    call(5, 'q1', 'AskUserQuestion', {
      questions: [
        {
          question: 'Which?',
          header: 'Pick',
          multiSelect: false,
          options: [
            { label: 'Option A', description: 'a' },
            { label: 'Option B', description: 'b' },
          ],
        },
      ],
    }),
    result(6, 'q1', 'Option A'),
    call(7, 'fg1', 'Agent', { subagent_type: 'Explore', description: 'Dig in', prompt: 'go' }),
    call(8, 'g1', 'Grep', { pattern: 'x' }, 'fg1'),
    result(9, 'g1', GREP_BODY, false, 'fg1'),
    result(10, 'fg1', REPORT),
    // A result the server no longer has (BODIES lacks it).
    call(11, 'gone', 'WebFetch', { url: 'https://example.com', prompt: 'p' }),
    result(12, 'gone', 'y'.repeat(2000)),
  ];

  function renderWithServer() {
    return renderWithTrpc(
      <MessageList
        sessionId="session-1"
        messages={messages}
        isLoading={false}
        hasMore={false}
        loadFailed={false}
        onLoadMore={() => {}}
      />,
      BODIES
    );
  }

  const cardTrigger = (title: string) => {
    const trigger = screen.getAllByText(title, { selector: 'span' })[0].closest('button');
    if (!trigger) throw new Error(`no ${title} card`);
    return trigger;
  };

  it('receives large bodies only as summaries and small ones inline', () => {
    const blockOf = (message: DisplayMessage) =>
      (message.content as { message: { content: { content?: unknown }[] } }).message.content[0];
    expect(blockOf(messages[2]).content).toBeUndefined();
    expect(blockOf(messages[4]).content).toBe('command failed');
  });

  it('shows collapsed badges from the summary without fetching anything', () => {
    const { requests } = renderWithServer();

    expect(screen.getByText('300 lines')).toBeInTheDocument();
    // The answered question renders expanded, from its inline answer.
    expect(screen.getByText('Response:').nextSibling?.textContent).toBe('Option A');
    expect(requests).toEqual([]);
  });

  it('fetches an elided body once, when its card is first expanded', async () => {
    const user = userEvent.setup();
    const { container, requests } = renderWithServer();

    await user.click(cardTrigger('Read'));
    await waitFor(() => expect(container.textContent).toContain('alpha300'));
    expect(requests).toEqual([{ messageId: 'm2', toolUseId: 'r1' }]);

    await user.click(cardTrigger('Read'));
    await user.click(cardTrigger('Read'));
    expect(container.textContent).toContain('alpha300');
    expect(requests).toHaveLength(1);
  });

  it('renders a short error without a fetch', async () => {
    const user = userEvent.setup();
    const { requests } = renderWithServer();

    await user.click(cardTrigger('Bash'));

    expect(screen.getByText('command failed')).toBeInTheDocument();
    expect(requests).toEqual([]);
  });

  it('expanding a subagent box fetches only its own result, not its nested cards', async () => {
    const user = userEvent.setup();
    const { container, requests } = renderWithServer();

    await user.click(cardTrigger('Task'));
    await waitFor(() => expect(container.textContent).toContain('The final report.'));
    // The nested Grep card stays collapsed, showing its count from the summary.
    expect(screen.getByText('200 matches')).toBeInTheDocument();
    expect(requests).toEqual([{ messageId: 'm10', toolUseId: 'fg1' }]);
  });

  /** The Copy button of the message bubble holding a tool card. */
  function copyButtonFor(title: string): HTMLElement {
    for (let node = cardTrigger(title).parentElement; node; node = node.parentElement) {
      const copy = within(node).queryByRole('button', { name: 'Copy' });
      if (copy) return copy;
    }
    throw new Error(`no Copy button around the ${title} card`);
  }

  it('copies a message with its full tool output, fetching the elided body', async () => {
    const user = userEvent.setup();
    const { requests } = renderWithServer();

    await user.click(copyButtonFor('Read'));

    await waitFor(async () => expect(await navigator.clipboard.readText()).toContain('alpha300'));
    expect(requests).toEqual([{ messageId: 'm2', toolUseId: 'r1' }]);
  });

  it('shows a missing body as an error at once, without retrying', async () => {
    const user = userEvent.setup();
    const { requests } = renderWithServer();

    await user.click(cardTrigger('WebFetch'));

    expect(await screen.findByText("Couldn't load the output.")).toBeInTheDocument();
    expect(requests).toEqual([{ messageId: 'm12', toolUseId: 'gone' }]);
  });

  it('says the copy failed, and copies nothing, when an output cannot be fetched', async () => {
    const user = userEvent.setup();
    vi.spyOn(console, 'error').mockImplementation(() => {});
    renderWithServer();
    await navigator.clipboard.writeText('before');

    await user.click(copyButtonFor('WebFetch'));

    expect(await screen.findByRole('button', { name: 'Copy failed' })).toBeInTheDocument();
    expect(await navigator.clipboard.readText()).toBe('before');
  });

  it('copies an inline output without a fetch', async () => {
    const user = userEvent.setup();
    const { requests } = renderWithServer();

    await user.click(copyButtonFor('Bash'));

    await waitFor(async () =>
      expect(await navigator.clipboard.readText()).toContain('command failed')
    );
    expect(requests).toEqual([]);
  });
});

describe('MessageList re-rendering', () => {
  const text = (id: string, sequence: number, body: string): DisplayMessage => ({
    id,
    type: 'assistant',
    sequence,
    createdAt: new Date(0),
    content: { parent_tool_use_id: null, message: { content: [{ type: 'text', text: body }] } },
  });
  const call: DisplayMessage = {
    id: 'call',
    type: 'assistant',
    sequence: 11,
    createdAt: new Date(0),
    content: {
      parent_tool_use_id: null,
      message: {
        content: [
          { type: 'text', text: 'running it' },
          { type: 'tool_use', id: 'toolu_bash', name: 'Bash', input: { command: 'ls' } },
        ],
      },
    },
  };
  const result: DisplayMessage = {
    id: 'result',
    type: 'user',
    sequence: 12,
    createdAt: new Date(0),
    content: {
      message: {
        content: [{ type: 'tool_result', tool_use_id: 'toolu_bash', content: 'a.txt' }],
      },
    },
  };
  const partial = (body: string): DisplayMessage => ({
    ...text('partial-main', 13, body),
    content: {
      partial: true,
      parent_tool_use_id: null,
      message: { content: [{ type: 'text', text: body }] },
    },
  });
  const list = (messages: DisplayMessage[]) => (
    <MessageList
      sessionId="session-1"
      messages={messages}
      isLoading={false}
      hasMore={false}
      loadFailed={false}
      onLoadMore={() => {}}
    />
  );
  const renders = (body: string) => markdownRenders.get(body) ?? 0;
  const loaded = [text('reply', 10, 'an earlier reply'), call];

  it('re-renders only the streaming bubble on each partial', () => {
    markdownRenders.clear();
    const { rerender } = renderWithTrpc(list(loaded));
    rerender(list([...loaded, partial('partial one')]));
    rerender(list([...loaded, partial('partial one two')]));

    expect(screen.getByText('partial one two')).toBeInTheDocument();
    expect(renders('an earlier reply')).toBe(1);
    expect(renders('running it')).toBe(1);
  });

  it('re-renders a bubble when its own result arrives, and no other', () => {
    markdownRenders.clear();
    const { rerender } = renderWithTrpc(list(loaded));
    rerender(list([...loaded, result]));

    expect(renders('running it')).toBe(2);
    expect(renders('an earlier reply')).toBe(1);
  });

  it('renders only the new bubbles when an older page is prepended', () => {
    markdownRenders.clear();
    const { rerender } = renderWithTrpc(list(loaded));
    rerender(list([text('older', 1, 'an older message'), ...loaded]));

    expect(renders('an older message')).toBe(1);
    expect(renders('an earlier reply')).toBe(1);
    expect(renders('running it')).toBe(1);
  });
});
