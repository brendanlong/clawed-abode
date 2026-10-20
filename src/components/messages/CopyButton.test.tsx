import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { CopyButton } from './CopyButton';

describe('CopyButton', () => {
  it('copies the text and says so', async () => {
    const user = userEvent.setup();
    render(<CopyButton getText={() => Promise.resolve('hello')} />);

    await user.click(screen.getByRole('button', { name: 'Copy' }));

    expect(await screen.findByRole('button', { name: 'Copied!' })).toBeInTheDocument();
    expect(await navigator.clipboard.readText()).toBe('hello');
  });

  it('shows that it is working while the text loads', async () => {
    const user = userEvent.setup();
    let resolve!: (text: string) => void;
    render(<CopyButton getText={() => new Promise<string>((r) => (resolve = r))} />);

    await user.click(screen.getByRole('button', { name: 'Copy' }));
    expect(await screen.findByRole('button', { name: 'Copying…' })).toBeInTheDocument();

    resolve('later');
    expect(await screen.findByRole('button', { name: 'Copied!' })).toBeInTheDocument();
    expect(await navigator.clipboard.readText()).toBe('later');
  });

  it('shows the failure, and copies nothing, when the text cannot be loaded', async () => {
    const user = userEvent.setup();
    vi.spyOn(console, 'error').mockImplementation(() => {});
    await navigator.clipboard.writeText('before');
    render(<CopyButton getText={() => Promise.reject(new Error('fetch failed'))} />);

    await user.click(screen.getByRole('button', { name: 'Copy' }));

    expect(await screen.findByRole('button', { name: 'Copy failed' })).toBeInTheDocument();
    expect(await navigator.clipboard.readText()).toBe('before');
  });
});
