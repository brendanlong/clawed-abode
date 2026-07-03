import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { ModelOverrideField } from './ModelOverrideField';

// The field queries model suggestions only while editing; a stub is enough.
vi.mock('@/lib/trpc', () => ({
  trpc: {
    globalSettings: {
      getModelSuggestions: {
        useQuery: () => ({ data: { models: [] } }),
      },
    },
  },
}));

describe('ModelOverrideField empty-save behavior', () => {
  it('adopts defaultModel on an empty save when emptySavesDefault is set', async () => {
    const user = userEvent.setup();
    const onSave = vi.fn();
    render(
      <ModelOverrideField
        currentModel={null}
        defaultModel="claude-fable-5"
        onSave={onSave}
        isPending={false}
        error={null}
        setButtonLabel="Enable"
        emptySavesDefault
      />
    );

    await user.click(screen.getByRole('button', { name: 'Enable' }));
    // Save without typing anything.
    await user.click(screen.getByRole('button', { name: 'Save' }));

    expect(onSave).toHaveBeenCalledTimes(1);
    expect(onSave.mock.calls[0][0]).toBe('claude-fable-5');
  });

  it('clears to null on an empty save by default', async () => {
    const user = userEvent.setup();
    const onSave = vi.fn();
    render(
      <ModelOverrideField
        currentModel={null}
        defaultModel="opus[1m]"
        onSave={onSave}
        isPending={false}
        error={null}
        setButtonLabel="Override"
      />
    );

    await user.click(screen.getByRole('button', { name: 'Override' }));
    await user.click(screen.getByRole('button', { name: 'Save' }));

    expect(onSave).toHaveBeenCalledTimes(1);
    expect(onSave.mock.calls[0][0]).toBeNull();
  });
});
