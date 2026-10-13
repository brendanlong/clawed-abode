import { describe, it, expect } from 'vitest';
import { useState } from 'react';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { KeyValueListEditor } from './KeyValueListEditor';
import { newKeyValueEntry, type KeyValueEntry } from '@/lib/key-value-entries';

function Harness({ initial }: { initial: KeyValueEntry[] }) {
  const [entries, setEntries] = useState(initial);
  return <KeyValueListEditor label="Headers" entries={entries} onChange={setEntries} />;
}

describe('KeyValueListEditor', () => {
  it('keeps each row bound to its own DOM nodes when an earlier row is removed', async () => {
    const user = userEvent.setup();
    render(
      <Harness
        initial={[
          newKeyValueEntry({ key: 'A', value: '1', isSecret: false }),
          newKeyValueEntry({ key: 'B', value: '2', isSecret: false }),
        ]}
      />
    );
    const bValue = screen.getByRole('textbox', { name: 'B value' });
    bValue.focus();

    await user.click(screen.getByRole('button', { name: 'Remove A' }));

    expect(screen.getByRole('textbox', { name: 'B value' })).toBe(bValue);
    expect(screen.queryByRole('textbox', { name: 'A value' })).not.toBeInTheDocument();
  });
});
