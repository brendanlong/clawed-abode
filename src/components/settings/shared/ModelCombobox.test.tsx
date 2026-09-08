import { describe, it, expect, vi } from 'vitest';
import { useState } from 'react';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { ModelCombobox } from './ModelCombobox';

vi.mock('@/lib/trpc', () => ({
  trpc: {
    globalSettings: {
      getModelSuggestions: {
        useQuery: () => ({ data: { models: ['claude-opus-5', 'claude-sonnet-5'] } }),
      },
    },
  },
}));

function ControlledCombobox({
  onChange,
  onEscape,
}: {
  onChange?: (value: string) => void;
  onEscape?: () => void;
}) {
  const [value, setValue] = useState('');
  return (
    <ModelCombobox
      value={value}
      onChange={(next) => {
        setValue(next);
        onChange?.(next);
      }}
      placeholder="model"
      onEscape={onEscape}
    />
  );
}

describe('ModelCombobox', () => {
  it('lets Enter fall through to the form when no onSubmit is given', async () => {
    const user = userEvent.setup();
    const onFormSubmit = vi.fn((e: React.FormEvent) => e.preventDefault());
    render(
      <form onSubmit={onFormSubmit}>
        <ModelCombobox value="" onChange={vi.fn()} placeholder="model" />
      </form>
    );

    await user.click(screen.getByPlaceholderText('model'));
    await user.keyboard('{Escape}{Enter}');

    expect(onFormSubmit).toHaveBeenCalledTimes(1);
  });

  it('calls onSubmit on Enter and does not submit the form', async () => {
    const user = userEvent.setup();
    const onSubmit = vi.fn();
    const onFormSubmit = vi.fn((e: React.FormEvent) => e.preventDefault());
    render(
      <form onSubmit={onFormSubmit}>
        <ModelCombobox value="" onChange={vi.fn()} placeholder="model" onSubmit={onSubmit} />
      </form>
    );

    await user.click(screen.getByPlaceholderText('model'));
    await user.keyboard('{Enter}');

    expect(onSubmit).toHaveBeenCalledTimes(1);
    expect(onFormSubmit).not.toHaveBeenCalled();
  });

  it('filters suggestions by the typed value and selects one', async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(<ControlledCombobox onChange={onChange} />);

    await user.type(screen.getByPlaceholderText('model'), 'sonnet');

    expect(await screen.findByText('claude-sonnet-5')).toBeInTheDocument();
    expect(screen.queryByText('claude-opus-5')).not.toBeInTheDocument();

    await user.click(screen.getByText('claude-sonnet-5'));
    expect(onChange).toHaveBeenLastCalledWith('claude-sonnet-5');
    expect(screen.getByPlaceholderText('model')).toHaveValue('claude-sonnet-5');
  });

  it('calls onEscape only once the popover is already closed', async () => {
    const user = userEvent.setup();
    const onEscape = vi.fn();
    render(<ControlledCombobox onEscape={onEscape} />);

    await user.type(screen.getByPlaceholderText('model'), 'c');
    expect(await screen.findByText('claude-opus-5')).toBeInTheDocument();

    await user.keyboard('{Escape}');
    expect(onEscape).not.toHaveBeenCalled();

    await user.keyboard('{Escape}');
    expect(onEscape).toHaveBeenCalledTimes(1);
  });
});
