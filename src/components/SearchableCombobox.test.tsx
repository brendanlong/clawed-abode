import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { SearchableCombobox } from './SearchableCombobox';

describe('SearchableCombobox', () => {
  it('highlights the current selection when opened, so Enter keeps it', async () => {
    const user = userEvent.setup();
    const onSelect = vi.fn();
    render(
      <SearchableCombobox
        triggerLabel="dev"
        ariaLabel="Branch"
        searchPlaceholder="Search"
        emptyText="None"
        query=""
        onQueryChange={vi.fn()}
        options={[
          { value: 'main', label: 'main', selected: false },
          { value: 'dev', label: 'dev', selected: true },
        ]}
        onSelect={onSelect}
      />
    );

    await user.click(screen.getByRole('combobox', { name: 'Branch' }));
    await user.keyboard('{Enter}');

    expect(onSelect).toHaveBeenCalledWith('dev');
  });
});
