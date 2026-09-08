import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { EnvVarSection, type EnvVarMutations } from './EnvVarSection';
import type { EnvVar } from '@/lib/settings-types';

/** What the routers actually send for a secret: the value is masked. */
const MASKED_SECRET: EnvVar = {
  id: 'e1',
  name: 'TOKEN',
  value: '••••••••',
  isSecret: true,
};

function mutations(overrides: Partial<EnvVarMutations> = {}): EnvVarMutations {
  return {
    deleteEnvVar: vi.fn().mockResolvedValue(undefined),
    setEnvVar: vi.fn().mockResolvedValue(undefined),
    getSecretValue: vi.fn().mockResolvedValue({ value: 'shh' }),
    ...overrides,
  };
}

describe('EnvVarSection', () => {
  it('submits an empty value for an untouched secret so the server keeps the stored one', async () => {
    const user = userEvent.setup();
    const m = mutations();
    render(<EnvVarSection envVars={[MASKED_SECRET]} mutations={m} onUpdate={vi.fn()} />);

    await user.click(screen.getByRole('button', { name: 'Edit' }));
    expect(screen.getByLabelText('Value')).toHaveValue('');
    await user.click(screen.getByRole('button', { name: 'Update' }));

    // Never the mask: a non-empty value would overwrite the real ciphertext.
    expect(m.setEnvVar).toHaveBeenCalledWith({ name: 'TOKEN', value: '', isSecret: true });
  });

  it('submits a retyped secret verbatim', async () => {
    const user = userEvent.setup();
    const m = mutations();
    render(<EnvVarSection envVars={[MASKED_SECRET]} mutations={m} onUpdate={vi.fn()} />);

    await user.click(screen.getByRole('button', { name: 'Edit' }));
    await user.type(screen.getByLabelText('Value'), 'new-token');
    await user.click(screen.getByRole('button', { name: 'Update' }));

    expect(m.setEnvVar).toHaveBeenCalledWith({ name: 'TOKEN', value: 'new-token', isSecret: true });
  });

  it('requires a value when demoting a secret to plain text', async () => {
    const user = userEvent.setup();
    const m = mutations();
    render(<EnvVarSection envVars={[MASKED_SECRET]} mutations={m} onUpdate={vi.fn()} />);

    await user.click(screen.getByRole('button', { name: 'Edit' }));
    await user.click(screen.getByRole('switch'));
    await user.click(screen.getByRole('button', { name: 'Update' }));

    // The server keys "unchanged" off the submitted isSecret, so a blank
    // non-secret submission would store the empty string.
    expect(screen.getByText('Value is required')).toBeInTheDocument();
    expect(m.setEnvVar).not.toHaveBeenCalled();

    await user.type(screen.getByLabelText('Value'), 'plain');
    await user.click(screen.getByRole('button', { name: 'Update' }));
    expect(m.setEnvVar).toHaveBeenCalledWith({ name: 'TOKEN', value: 'plain', isSecret: false });
  });

  it('requires a value for a brand new secret, which has nothing stored to keep', async () => {
    const user = userEvent.setup();
    const m = mutations();
    render(<EnvVarSection envVars={[]} mutations={m} onUpdate={vi.fn()} />);

    await user.click(screen.getByRole('button', { name: 'Add' }));
    await user.type(screen.getByLabelText('Name'), 'NEW_TOKEN');
    await user.click(screen.getByRole('switch'));
    // The section's "Add" and the open form's submit share a name.
    const [, submit] = screen.getAllByRole('button', { name: 'Add' });
    await user.click(submit);

    expect(screen.getByText('Value is required')).toBeInTheDocument();
    expect(m.setEnvVar).not.toHaveBeenCalled();
  });

  it('promotes a plain var to a secret, keeping its typed value', async () => {
    const user = userEvent.setup();
    const m = mutations();
    const plain: EnvVar = { id: 'e2', name: 'PLAIN', value: 'v1', isSecret: false };
    render(<EnvVarSection envVars={[plain]} mutations={m} onUpdate={vi.fn()} />);

    await user.click(screen.getByRole('button', { name: 'Edit' }));
    await user.click(screen.getByRole('switch'));
    await user.click(screen.getByRole('button', { name: 'Update' }));

    expect(m.setEnvVar).toHaveBeenCalledWith({ name: 'PLAIN', value: 'v1', isSecret: true });
  });

  it('requires a value for a non-secret var', async () => {
    const user = userEvent.setup();
    const m = mutations();
    const plain: EnvVar = { id: 'e2', name: 'PLAIN', value: 'v1', isSecret: false };
    render(<EnvVarSection envVars={[plain]} mutations={m} onUpdate={vi.fn()} />);

    await user.click(screen.getByRole('button', { name: 'Edit' }));
    await user.clear(screen.getByLabelText('Value'));
    await user.click(screen.getByRole('button', { name: 'Update' }));

    expect(screen.getByText('Value is required')).toBeInTheDocument();
    expect(m.setEnvVar).not.toHaveBeenCalled();
  });

  it('reveals and re-hides a secret through the labelled toggle', async () => {
    const user = userEvent.setup();
    const m = mutations();
    render(<EnvVarSection envVars={[MASKED_SECRET]} mutations={m} onUpdate={vi.fn()} />);

    await user.click(screen.getByRole('button', { name: 'Show value' }));
    expect(await screen.findByText('shh')).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Hide value' }));
    expect(screen.queryByText('shh')).not.toBeInTheDocument();
  });

  it('notifies the parent once after a confirmed delete', async () => {
    const user = userEvent.setup();
    const onUpdate = vi.fn();
    const m = mutations();
    render(<EnvVarSection envVars={[MASKED_SECRET]} mutations={m} onUpdate={onUpdate} />);

    await user.click(screen.getByRole('button', { name: 'Delete TOKEN' }));
    await user.click(screen.getByRole('button', { name: 'Delete' }));

    expect(m.deleteEnvVar).toHaveBeenCalledWith('TOKEN');
    expect(onUpdate).toHaveBeenCalledTimes(1);
  });
});
