import { describe, it, expect, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { PermissionRequestsPanel } from './PermissionRequestsPanel';
import type { PermissionRequest } from '@/lib/permission-request';

const writeRequest: PermissionRequest = {
  toolUseId: 't1',
  toolName: 'Write',
  input: { file_path: '/repo/app.ts', content: 'export const replaced = true;' },
  title: null,
  description: null,
  reason: 'Overwrites a tracked file',
  agentId: null,
};

describe('PermissionRequestsPanel', () => {
  it('renders nothing when no request is waiting', () => {
    const { container } = render(<PermissionRequestsPanel requests={[]} onRespond={vi.fn()} />);
    expect(container).toBeEmptyDOMElement();
  });

  it('lets the user inspect the full input before approving', async () => {
    const user = userEvent.setup();
    const onRespond = vi.fn(async () => {});
    render(<PermissionRequestsPanel requests={[writeRequest]} onRespond={onRespond} />);

    expect(screen.getByText('/repo/app.ts')).toBeInTheDocument();
    expect(screen.getByText('Overwrites a tracked file')).toBeInTheDocument();
    expect(screen.queryByText(/export const replaced/)).not.toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Show full input' }));
    expect(screen.getByText(/export const replaced = true/)).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Allow' }));
    expect(onRespond).toHaveBeenCalledWith('t1', true, undefined);
  });

  it('sends the note with a deny and shows a failure to respond', async () => {
    const user = userEvent.setup();
    const onRespond = vi.fn(async () => {
      throw new Error('This permission request is no longer pending.');
    });
    render(<PermissionRequestsPanel requests={[writeRequest]} onRespond={onRespond} />);

    await user.type(screen.getByRole('textbox'), 'use a new file');
    await user.click(screen.getByRole('button', { name: 'Deny' }));
    expect(onRespond).toHaveBeenCalledWith('t1', false, 'use a new file');
    await waitFor(() =>
      expect(screen.getByText('This permission request is no longer pending.')).toBeInTheDocument()
    );
    expect(screen.getByRole('button', { name: 'Deny' })).toBeEnabled();
  });
});
