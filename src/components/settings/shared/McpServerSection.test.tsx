import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { McpServerSection, type McpServerMutations } from './McpServerSection';
import type { McpServer } from '@/lib/settings-types';

// The form asks the server for the OAuth redirect URI to display; nothing else
// in this tree talks to tRPC, and the query needs a provider we don't want here.
vi.mock('@/lib/trpc', () => ({
  trpc: {
    globalSettings: { getMcpOAuthRedirectUri: { useQuery: () => ({ data: undefined }) } },
  },
}));

const MASK = '••••••••';

/** What the routers actually send for an http server: header secrets are masked. */
const HTTP_SERVER: McpServer = {
  id: 'm1',
  name: 'remote',
  type: 'http',
  command: '',
  args: [],
  env: {},
  url: 'https://mcp.example.com',
  headers: {
    Authorization: { value: MASK, isSecret: true },
    'X-Api-Version': { value: '2', isSecret: false },
  },
  authType: 'headers',
};

function mutations(overrides: Partial<McpServerMutations> = {}): McpServerMutations {
  return {
    deleteMcpServer: vi.fn().mockResolvedValue(undefined),
    setMcpServer: vi.fn().mockResolvedValue(undefined),
    validateMcpServer: vi.fn().mockResolvedValue({ success: true }),
    startMcpOAuth: vi.fn().mockResolvedValue({ authorizeUrl: 'https://auth.example.com' }),
    disconnectMcpOAuth: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  };
}

async function openEditForm(m: McpServerMutations) {
  const user = userEvent.setup();
  render(<McpServerSection mcpServers={[HTTP_SERVER]} mutations={m} onUpdate={vi.fn()} />);
  await user.click(screen.getByRole('button', { name: 'Edit' }));
  return user;
}

describe('McpServerSection', () => {
  it('submits an empty value for an untouched secret header so the server keeps the stored one', async () => {
    const m = mutations();
    const user = await openEditForm(m);

    expect(screen.getByLabelText('Authorization value')).toHaveValue('');
    expect(screen.getByLabelText('Authorization value')).toHaveAttribute(
      'placeholder',
      '(unchanged)'
    );
    await user.click(screen.getByRole('button', { name: 'Update' }));

    // Never the mask: a non-empty value would overwrite the real ciphertext.
    expect(m.setMcpServer).toHaveBeenCalledWith(
      expect.objectContaining({
        headers: {
          Authorization: { value: '', isSecret: true },
          'X-Api-Version': { value: '2', isSecret: false },
        },
      })
    );
  });

  it('requires a value when demoting a secret header to plain text', async () => {
    const m = mutations();
    const user = await openEditForm(m);

    await user.click(screen.getByLabelText('Authorization is secret'));
    await user.click(screen.getByRole('button', { name: 'Update' }));

    // The server keys "unchanged" off the submitted isSecret, so a blank
    // non-secret submission would store the empty string over the ciphertext.
    expect(screen.getByText('The header "Authorization" needs a value')).toBeInTheDocument();
    expect(m.setMcpServer).not.toHaveBeenCalled();

    await user.type(screen.getByLabelText('Authorization value'), 'Bearer plain');
    await user.click(screen.getByRole('button', { name: 'Update' }));
    expect(m.setMcpServer).toHaveBeenCalledWith(
      expect.objectContaining({
        headers: expect.objectContaining({
          Authorization: { value: 'Bearer plain', isSecret: false },
        }),
      })
    );
  });

  it('rejects a cleared plain header value rather than storing an empty string', async () => {
    const m = mutations();
    const user = await openEditForm(m);

    await user.clear(screen.getByLabelText('X-Api-Version value'));
    await user.click(screen.getByRole('button', { name: 'Update' }));

    expect(screen.getByText('The header "X-Api-Version" needs a value')).toBeInTheDocument();
    expect(m.setMcpServer).not.toHaveBeenCalled();
  });

  it('rejects a header value with no name instead of silently dropping the row', async () => {
    const m = mutations();
    const user = await openEditForm(m);

    await user.click(screen.getByRole('button', { name: 'Add to Headers' }));
    await user.type(screen.getByLabelText('Headers value (row 3)'), 'orphan');
    await user.click(screen.getByRole('button', { name: 'Update' }));

    expect(screen.getByText('Every header needs a name')).toBeInTheDocument();
    expect(m.setMcpServer).not.toHaveBeenCalled();
  });

  it('drops a header row that was added and never filled in', async () => {
    const m = mutations();
    const user = await openEditForm(m);

    await user.click(screen.getByRole('button', { name: 'Add to Headers' }));
    await user.click(screen.getByRole('button', { name: 'Update' }));

    expect(m.setMcpServer).toHaveBeenCalledWith(
      expect.objectContaining({
        headers: {
          Authorization: { value: '', isSecret: true },
          'X-Api-Version': { value: '2', isSecret: false },
        },
      })
    );
  });
});
