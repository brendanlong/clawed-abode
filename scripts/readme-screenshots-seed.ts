#!/usr/bin/env tsx
/**
 * Fills an empty database with the demo sessions the README screenshots show.
 * Run by scripts/readme-screenshots.ts with DATABASE_URL pointing at a throwaway
 * database under the temp dir; refuses any other.
 *
 * The sessions get no workspace directories, so the server doesn't start a CLI
 * for the "running" ones: starting one would also reapply the sessions' systemd
 * slice limits, which the real server shares.
 */
import { randomUUID } from 'node:crypto';
import { tmpdir } from 'node:os';
import { prisma } from '@/lib/prisma';
import type { PullRequestInfo } from '@/lib/pull-request';
import { insertMessage } from '@/server/services/message-store';

const MODEL = 'claude-opus-5-5';
const MINUTE = 60 * 1000;

type Block =
  | { type: 'text'; text: string }
  | { type: 'tool_use'; name: string; input: Record<string, unknown>; result: string };

interface DemoSession {
  name: string;
  repo: string | null;
  status: 'running' | 'stopped';
  minutesAgo: number;
  pullRequest?: Omit<PullRequestInfo, 'url' | 'author' | 'updatedAt' | 'headBranch' | 'headSha'>;
  attention?: string;
  transcript?: { prompt: string; turns: Block[][]; costUsd: number }[];
}

function usage(output: number): Record<string, number> {
  return {
    input_tokens: 4,
    cache_creation_input_tokens: 2400,
    cache_read_input_tokens: 61_000,
    output_tokens: output,
  };
}

async function insertTranscript(
  sessionId: string,
  transcript: NonNullable<DemoSession['transcript']>
) {
  for (const { prompt, turns, costUsd } of transcript) {
    await insertMessage({
      sessionId,
      id: randomUUID(),
      type: 'user',
      content: { type: 'user', content: prompt },
    });
    for (const blocks of turns) {
      const messageId = `msg_${randomUUID().replaceAll('-', '')}`;
      for (const block of blocks) {
        const toolUseId = `toolu_${randomUUID().replaceAll('-', '')}`;
        const contentBlock =
          block.type === 'text'
            ? block
            : { type: 'tool_use', id: toolUseId, name: block.name, input: block.input };
        await insertMessage({
          sessionId,
          id: randomUUID(),
          type: 'assistant',
          content: {
            type: 'assistant',
            message: {
              model: MODEL,
              id: messageId,
              type: 'message',
              role: 'assistant',
              content: [contentBlock],
              stop_reason: null,
              usage: usage(200),
            },
            parent_tool_use_id: null,
            session_id: sessionId,
            uuid: randomUUID(),
          },
        });
        if (block.type === 'tool_use') {
          await insertMessage({
            sessionId,
            id: randomUUID(),
            type: 'user',
            content: {
              type: 'user',
              message: {
                role: 'user',
                content: [{ type: 'tool_result', tool_use_id: toolUseId, content: block.result }],
              },
              parent_tool_use_id: null,
              session_id: sessionId,
              uuid: randomUUID(),
            },
          });
        }
      }
    }
    await insertMessage({
      sessionId,
      id: randomUUID(),
      type: 'result',
      content: {
        type: 'result',
        subtype: 'success',
        is_error: false,
        duration_ms: 214_000,
        num_turns: turns.length,
        session_id: sessionId,
        total_cost_usd: costUsd,
        usage: usage(4800),
        uuid: randomUUID(),
      },
    });
  }
}

const unreadTitleTranscript: DemoSession['transcript'] = [
  {
    prompt:
      'Can you show the unread count in the browser tab title, like Gmail does? Something like "(12) Lion Reader". Make sure it updates when entries are marked read.',
    costUsd: 1.84,
    turns: [
      [
        {
          type: 'text',
          text: "I'll find where the unread counts live and where the page title is set.",
        },
        {
          type: 'tool_use',
          name: 'Grep',
          input: { pattern: 'document\\.title|useUnreadCounts', path: 'src' },
          result: [
            'src/components/layout/AppShell.tsx',
            'src/lib/hooks/useUnreadCounts.ts',
            'src/components/subscriptions/SubscriptionList.tsx',
          ].join('\n'),
        },
        {
          type: 'tool_use',
          name: 'Read',
          input: { file_path: 'src/lib/hooks/useUnreadCounts.ts' },
          result: [
            "     1\timport { trpc } from '@/lib/trpc/client';",
            '     2\t',
            '     3\texport function useUnreadCounts() {',
            '     4\t  const { data } = trpc.subscriptions.unreadCounts.useQuery();',
            '     5\t  return data ?? { total: 0, bySubscription: {} };',
            '     6\t}',
          ].join('\n'),
        },
      ],
      [
        {
          type: 'text',
          text: "The counts are already cached by React Query and refreshed whenever entries are marked read, so the title only needs to follow `total`. I'll add a small hook and call it from the app shell.",
        },
        {
          type: 'tool_use',
          name: 'Write',
          input: {
            file_path: 'src/lib/hooks/useUnreadTitle.ts',
            content: [
              "import { useEffect } from 'react';",
              "import { useUnreadCounts } from './useUnreadCounts';",
              '',
              "const APP_NAME = 'Lion Reader';",
              '',
              'export function formatUnreadTitle(total: number): string {',
              '  if (total === 0) return APP_NAME;',
              "  return `(${total > 999 ? '999+' : total}) ${APP_NAME}`;",
              '}',
              '',
              'export function useUnreadTitle() {',
              '  const { total } = useUnreadCounts();',
              '  useEffect(() => {',
              '    document.title = formatUnreadTitle(total);',
              '  }, [total]);',
              '}',
            ].join('\n'),
          },
          result: 'File created successfully at: src/lib/hooks/useUnreadTitle.ts',
        },
        {
          type: 'tool_use',
          name: 'Edit',
          input: {
            file_path: 'src/components/layout/AppShell.tsx',
            old_string:
              'export function AppShell({ children }: AppShellProps) {\n  const sidebar = useSidebar();',
            new_string:
              'export function AppShell({ children }: AppShellProps) {\n  const sidebar = useSidebar();\n  useUnreadTitle();',
          },
          result: 'The file src/components/layout/AppShell.tsx has been updated successfully.',
        },
        {
          type: 'tool_use',
          name: 'Bash',
          input: {
            command: 'pnpm test:unit src/lib/hooks/useUnreadTitle.test.ts',
            description: 'Run the new title tests',
          },
          result: [
            ' RUN  v5.0.5 /home/claude/worktrees/lion-reader',
            '',
            ' ✓ src/lib/hooks/useUnreadTitle.test.ts (4 tests) 12ms',
            '   ✓ shows just the app name with nothing unread',
            '   ✓ prefixes the unread count',
            '   ✓ caps large counts at 999+',
            '   ✓ updates when the count changes',
            '',
            ' Test Files  1 passed (1)',
            '      Tests  4 passed (4)',
          ].join('\n'),
        },
        {
          type: 'tool_use',
          name: 'Bash',
          input: {
            command:
              'git add -A && git commit -qm "Show the unread count in the tab title" && git push -q -u origin HEAD && gh pr create --fill',
            description: 'Commit, push, and open a PR',
          },
          result: 'https://github.com/brendanlong/lion-reader/pull/2141',
        },
      ],
      [
        {
          type: 'text',
          text: [
            'Done: the tab now reads **(12) Lion Reader** when you have 12 unread entries, and just **Lion Reader** at zero. PR: https://github.com/brendanlong/lion-reader/pull/2141',
            '',
            '- `useUnreadTitle` follows the same cached unread counts the sidebar uses, so marking entries read updates the title with no extra requests.',
            '- Counts above 999 show as `999+` so the title stays readable in narrow tabs.',
            '- Four unit tests cover the formatting and the update on change.',
          ].join('\n'),
        },
      ],
    ],
  },
];

const sweepTranscript: DemoSession['transcript'] = [
  {
    prompt:
      'Run the learning-rate sweep for the small model on the local GPU (1e-4 to 1e-3, 3 seeds each) and tell me which one wins.',
    costUsd: 3.12,
    turns: [
      [
        {
          type: 'tool_use',
          name: 'Bash',
          input: {
            command: 'nvidia-smi --query-gpu=name,memory.used,memory.total --format=csv',
            description: 'Check the GPU is free',
          },
          result:
            'name, memory.used [MiB], memory.total [MiB]\nNVIDIA GeForce RTX 5090, 412 MiB, 32607 MiB',
        },
        {
          type: 'tool_use',
          name: 'Bash',
          input: {
            command: 'snakemake --cores 1 --resources gpu=1 sweep_lr',
            description: 'Run the sweep (12 runs)',
          },
          result: [
            'Building DAG of jobs...',
            'Job stats:',
            'job         count',
            '--------  -------',
            'sweep_lr        1',
            'train          12',
            'total          13',
            '...',
            '13 of 13 steps (100%) done',
          ].join('\n'),
        },
      ],
      [
        {
          type: 'text',
          text: [
            'The sweep finished: all 12 runs completed in 41 minutes on the RTX 5090.',
            '',
            '| Learning rate | Final eval loss (mean ± sd) |',
            '| --- | --- |',
            '| 1e-4 | 3.412 ± 0.011 |',
            '| 3e-4 | **3.287 ± 0.008** |',
            '| 6e-4 | 3.301 ± 0.019 |',
            '| 1e-3 | 3.355 ± 0.046 |',
            '',
            '**3e-4 wins**, and it is also the most stable across seeds. 1e-3 diverged briefly early on in one seed, which is where its spread comes from. Loss curves are on the results page: https://example.ts.net/experiments/lr-sweep/',
          ].join('\n'),
        },
      ],
    ],
  },
];

const sessions: DemoSession[] = [
  {
    name: 'Unread count in tab title',
    repo: 'brendanlong/lion-reader',
    status: 'running',
    minutesAgo: 2,
    pullRequest: {
      number: 2141,
      title: 'Show the unread count in the tab title',
      state: 'open',
      draft: false,
      stackedOn: null,
      checks: 'success',
    },
    attention: 'Opened PR #2141 for the tab title',
    transcript: unreadTitleTranscript,
  },
  {
    name: 'Learning-rate sweep',
    repo: 'brendanlong/experiments',
    status: 'running',
    minutesAgo: 9,
    attention: 'Sweep done: 3e-4 wins',
    transcript: sweepTranscript,
  },
  {
    name: 'Fix flaky reconnect test',
    repo: 'brendanlong/clawed-abode',
    status: 'running',
    minutesAgo: 23,
    pullRequest: {
      number: 702,
      title: 'Wait for the resume cursor before asserting replayed events',
      state: 'open',
      draft: true,
      stackedOn: null,
      checks: 'pending',
    },
  },
  {
    name: 'Compare TTS latency',
    repo: null,
    status: 'running',
    minutesAgo: 47,
  },
  {
    name: 'E-ink theme contrast',
    repo: 'brendanlong/lion-reader',
    status: 'stopped',
    minutesAgo: 180,
    pullRequest: {
      number: 2133,
      title: 'Raise contrast of muted text in the e-ink theme',
      state: 'merged',
      draft: false,
      stackedOn: null,
      checks: 'success',
    },
  },
  {
    name: 'Upgrade to Next.js 16',
    repo: 'brendanlong/clawed-abode',
    status: 'stopped',
    minutesAgo: 26 * 60,
    pullRequest: {
      number: 688,
      title: 'Upgrade to Next.js 16',
      state: 'merged',
      draft: false,
      stackedOn: null,
      checks: 'success',
    },
  },
];

async function main() {
  if (!process.env.DATABASE_URL?.startsWith(`file:${tmpdir()}/`)) {
    throw new Error('Refusing to seed a database outside the temp dir');
  }
  const now = Date.now();
  for (const demo of sessions) {
    const id = randomUUID();
    const repoName = demo.repo?.split('/')[1] ?? '';
    const branch = `claude/${id}`;
    const pullRequest: PullRequestInfo | null = demo.pullRequest
      ? {
          ...demo.pullRequest,
          url: `https://github.com/${demo.repo}/pull/${demo.pullRequest.number}`,
          author: 'brendanlong',
          updatedAt: new Date(now - demo.minutesAgo * MINUTE).toISOString(),
          headBranch: branch,
          headSha: '',
        }
      : null;
    await prisma.session.create({
      data: {
        id,
        name: demo.name,
        repoUrl: demo.repo ? `https://github.com/${demo.repo}.git` : null,
        branch: demo.repo ? 'main' : null,
        repoPath: repoName,
        status: demo.status,
        currentBranch: demo.repo ? branch : null,
        // Directly rather than through pull-request-store: there is no GitHub PR to link.
        pullRequest: pullRequest && JSON.stringify(pullRequest),
        // Far enough ahead that the server never asks GitHub about these made-up PRs.
        prCheckedAt: new Date(now + 365 * 24 * 60 * MINUTE),
        lastActivityAt: new Date(now - demo.minutesAgo * MINUTE),
        attentionAt: demo.attention ? new Date(now - demo.minutesAgo * MINUTE) : null,
        attentionSummary: demo.attention ?? null,
      },
    });
    if (demo.transcript) await insertTranscript(id, demo.transcript);
  }
}

main()
  .then(() => prisma.$disconnect())
  .catch(async (err: unknown) => {
    console.error(err);
    await prisma.$disconnect();
    process.exit(1);
  });
