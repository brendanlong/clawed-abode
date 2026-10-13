import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { McpToolFilterEditor } from './McpToolFilterEditor';
import type { McpServer, ValidationResult } from '@/lib/settings-types';
import type { McpToolFilter } from '@/lib/mcp-tool-filter';
import { QueryClientWrapper } from '@/test/query-client-wrapper';

const SERVER: McpServer = {
  id: 'm1',
  updatedAt: new Date(0),
  toolFilter: null,
  name: 'todo',
  type: 'stdio',
  command: 'npx',
  args: [],
  env: {},
  headers: {},
  authType: 'headers',
};

const LISTED: ValidationResult = {
  success: true,
  tools: [
    { name: 'find-tasks', description: 'Search tasks', readOnly: true },
    { name: 'add-tasks', readOnly: false },
    { name: 'get-overview', readOnly: true },
  ],
};

function renderEditor(
  server: McpServer,
  listTools: () => Promise<ValidationResult> = async () => LISTED
) {
  const save = vi.fn(async (_filter: McpToolFilter | null) => {});
  const onSaved = vi.fn();
  render(
    <McpToolFilterEditor
      server={server}
      listTools={listTools}
      save={save}
      onClose={vi.fn()}
      onSaved={onSaved}
    />,
    { wrapper: QueryClientWrapper }
  );
  return { user: userEvent.setup(), save, onSaved };
}

describe('McpToolFilterEditor', () => {
  it('limits an unfiltered server to the tools the server claims are read-only', async () => {
    const { user, save, onSaved } = renderEditor(SERVER);

    await user.click(screen.getByLabelText('Only allow selected tools'));
    expect(await screen.findByLabelText(/add-tasks/)).toBeChecked();
    await user.click(screen.getByRole('button', { name: 'Read-only' }));
    expect(screen.getByLabelText(/add-tasks/)).not.toBeChecked();
    await user.click(screen.getByRole('button', { name: 'Save' }));

    expect(save).toHaveBeenCalledWith({
      allowed: ['find-tasks', 'get-overview'],
      hidden: ['add-tasks'],
    });
    expect(onSaved).toHaveBeenCalled();
  });

  it('starts from the stored allowlist and saves individual changes', async () => {
    const { user, save } = renderEditor({
      ...SERVER,
      toolFilter: { allowed: ['find-tasks'], hidden: ['add-tasks', 'get-overview'] },
    });

    expect(await screen.findByLabelText(/find-tasks/)).toBeChecked();
    expect(screen.getByLabelText(/get-overview/)).not.toBeChecked();
    await user.click(screen.getByLabelText(/get-overview/));
    await user.click(screen.getByRole('button', { name: 'Save' }));

    expect(save).toHaveBeenCalledWith({
      allowed: ['find-tasks', 'get-overview'],
      hidden: ['add-tasks'],
    });
  });

  it('can go back to all tools even when the server cannot be reached', async () => {
    const { user, save } = renderEditor(
      { ...SERVER, toolFilter: { allowed: ['find-tasks'], hidden: [] } },
      async () => ({ success: false, error: 'Connection refused - is the server running?' })
    );

    expect(await screen.findByText('Connection refused - is the server running?')).toBeVisible();
    expect(screen.getByRole('button', { name: 'Save' })).toBeDisabled();
    await user.click(screen.getByLabelText('Only allow selected tools'));
    await user.click(screen.getByRole('button', { name: 'Save' }));

    expect(save).toHaveBeenCalledWith(null);
  });
});
