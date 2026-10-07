import { afterEach, describe, it, expect, vi } from 'vitest';
import type { ReactElement } from 'react';
import { render as rtlRender, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { McpServerSection, type McpServerMutations } from './McpServerSection';
import type { McpServer } from '@/lib/settings-types';
import { QueryClientWrapper } from '@/test/query-client-wrapper';

const render = (ui: ReactElement) => rtlRender(ui, { wrapper: QueryClientWrapper });

// The form asks the server for the OAuth redirect URI to display; nothing else
// in this tree talks to tRPC, so a tRPC client isn't worth standing up for it.
vi.mock('@/lib/trpc', () => ({
  trpc: {
    globalSettings: { getMcpOAuthRedirectUri: { useQuery: () => ({ data: undefined }) } },
  },
}));

const MASK = '••••••••';

/** What the routers actually send for an http server: header secrets are masked. */
const HTTP_SERVER: McpServer = {
  id: 'm1',
  updatedAt: new Date(0),
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
  render(
    <McpServerSection mcpServers={[HTTP_SERVER]} mutations={m} onUpdate={vi.fn()} scope="repo" />
  );
  await user.click(screen.getByRole('button', { name: 'Edit' }));
  return user;
}

describe('McpServerSection', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

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

    // The placeholder must stop promising "unchanged" as soon as the flag drops,
    // since that's exactly when the blank value stops being preserved.
    expect(screen.getByLabelText('Authorization value')).toHaveAttribute('placeholder', 'value');

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

  it('shows why an OAuth connect failed and clears it on retry', async () => {
    const user = userEvent.setup();
    const oauthServer: McpServer = {
      ...HTTP_SERVER,
      headers: {},
      authType: 'oauth',
      oauth: {
        state: 'connected',
        clientId: null,
        clientIdIsManual: false,
        scope: null,
        authorizedAt: null,
        error: null,
      },
    };
    let rejectRetry: (err: Error) => void = () => {};
    const m = mutations({
      startMcpOAuth: vi
        .fn()
        .mockRejectedValueOnce(new Error('discovery failed'))
        .mockReturnValueOnce(
          new Promise((_, reject) => {
            rejectRetry = reject;
          })
        ),
    });
    render(
      <McpServerSection mcpServers={[oauthServer]} mutations={m} onUpdate={vi.fn()} scope="repo" />
    );

    await user.click(screen.getByTitle('Re-authorize with OAuth'));
    expect(await screen.findByText('discovery failed')).toBeInTheDocument();

    await user.click(screen.getByTitle('Re-authorize with OAuth'));
    expect(screen.queryByText('discovery failed')).not.toBeInTheDocument();
    rejectRetry(new Error('still broken'));
    expect(await screen.findByText('still broken')).toBeInTheDocument();
  });

  it('navigates to the authorization URL and stays busy while leaving', async () => {
    const user = userEvent.setup();
    const assign = vi.fn();
    vi.stubGlobal('location', { ...window.location, assign });
    const oauthServer: McpServer = { ...HTTP_SERVER, headers: {}, authType: 'oauth' };
    const m = mutations();
    render(
      <McpServerSection mcpServers={[oauthServer]} mutations={m} onUpdate={vi.fn()} scope="repo" />
    );

    await user.click(screen.getByTitle('Connect with OAuth'));

    expect(m.startMcpOAuth).toHaveBeenCalledWith('remote');
    expect(assign).toHaveBeenCalledWith('https://auth.example.com');
    expect(screen.getByTitle('Connect with OAuth')).toBeDisabled();
  });

  it('clears a connect error when disconnecting, and refetches once disconnected', async () => {
    const user = userEvent.setup();
    const onUpdate = vi.fn();
    const oauthServer: McpServer = {
      ...HTTP_SERVER,
      headers: {},
      authType: 'oauth',
      oauth: {
        state: 'connected',
        clientId: null,
        clientIdIsManual: false,
        scope: null,
        authorizedAt: null,
        error: null,
      },
    };
    const m = mutations({
      startMcpOAuth: vi.fn().mockRejectedValue(new Error('discovery failed')),
    });
    render(
      <McpServerSection mcpServers={[oauthServer]} mutations={m} onUpdate={onUpdate} scope="repo" />
    );

    await user.click(screen.getByTitle('Re-authorize with OAuth'));
    expect(await screen.findByText('discovery failed')).toBeInTheDocument();

    await user.click(screen.getByTitle('Disconnect'));
    expect(m.disconnectMcpOAuth).toHaveBeenCalledWith('remote');
    expect(screen.queryByText('discovery failed')).not.toBeInTheDocument();
    expect(onUpdate).toHaveBeenCalledTimes(1);
  });

  it('tests each server independently', async () => {
    const user = userEvent.setup();
    const other: McpServer = { ...HTTP_SERVER, id: 'm2', name: 'other' };
    let resolveFirst: (result: { success: boolean; error?: string }) => void = () => {};
    const m = mutations({
      validateMcpServer: vi
        .fn()
        .mockReturnValueOnce(
          new Promise((resolve) => {
            resolveFirst = resolve;
          })
        )
        .mockRejectedValueOnce(new Error('unreachable')),
    });
    render(
      <McpServerSection
        mcpServers={[HTTP_SERVER, other]}
        mutations={m}
        onUpdate={vi.fn()}
        scope="repo"
      />
    );

    const [testFirst, testOther] = screen.getAllByTitle('Test connection');
    await user.click(testFirst);
    // One server's test in flight must not block testing another.
    expect(testFirst).toBeDisabled();
    expect(testOther).toBeEnabled();

    await user.click(testOther);
    expect(await screen.findByText('unreachable')).toBeInTheDocument();
    resolveFirst({ success: false, error: 'bad token' });
    expect(await screen.findByText('bad token')).toBeInTheDocument();
    expect(m.validateMcpServer).toHaveBeenNthCalledWith(1, 'remote');
    expect(m.validateMcpServer).toHaveBeenNthCalledWith(2, 'other');
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
