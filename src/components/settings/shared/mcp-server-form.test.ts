import { describe, it, expect } from 'vitest';
import { buildMcpServerInput, initialMcpServerForm } from './mcp-server-form';
import type { McpServer } from '@/lib/settings-types';

describe('initialMcpServerForm', () => {
  it('creates empty fields when no existing server', () => {
    expect(initialMcpServerForm()).toEqual({
      name: '',
      serverType: 'stdio',
      command: '',
      args: '',
      envVars: [],
      url: '',
      headers: [],
      authType: 'headers',
      oauthClientId: '',
      oauthClientSecret: '',
      oauthScope: '',
    });
  });

  it('populates from existing stdio server', () => {
    const form = initialMcpServerForm({
      id: '1',
      authType: 'headers',
      name: 'memory',
      type: 'stdio',
      command: 'npx',
      args: ['@anthropic/mcp-server-memory'],
      env: { API_KEY: { value: 'key123', isSecret: false } },
      headers: {},
    });
    expect(form.name).toBe('memory');
    expect(form.serverType).toBe('stdio');
    expect(form.command).toBe('npx');
    expect(form.args).toBe('@anthropic/mcp-server-memory');
    expect(form.envVars).toEqual([{ key: 'API_KEY', value: 'key123', isSecret: false }]);
  });

  it('populates from existing HTTP server, blanking masked secret headers', () => {
    const form = initialMcpServerForm({
      id: '2',
      authType: 'headers',
      name: 'web-server',
      type: 'http',
      command: '',
      args: [],
      env: {},
      url: 'https://example.com/mcp',
      headers: { Authorization: { value: '••••••••', isSecret: true } },
    });
    expect(form.name).toBe('web-server');
    expect(form.serverType).toBe('http');
    expect(form.url).toBe('https://example.com/mcp');
    expect(form.headers).toEqual([{ key: 'Authorization', value: '', isSecret: true }]);
  });

  it('blanks masked secret env var values', () => {
    const form = initialMcpServerForm({
      id: '3',
      authType: 'headers',
      name: 'test',
      type: 'stdio',
      command: 'node',
      args: [],
      env: { SECRET: { value: '••••••••', isSecret: true } },
      headers: {},
    });
    expect(form.envVars).toEqual([{ key: 'SECRET', value: '', isSecret: true }]);
  });

  it('joins args with spaces', () => {
    const form = initialMcpServerForm({
      id: '3',
      authType: 'headers',
      name: 'test',
      type: 'stdio',
      command: 'node',
      args: ['--flag', 'value', '--other'],
      env: {},
      headers: {},
    });
    expect(form.args).toBe('--flag value --other');
  });

  it('only pre-fills an OAuth client ID the user entered themselves', () => {
    const base = {
      id: '4',
      authType: 'oauth' as const,
      name: 'remote',
      type: 'http' as const,
      command: '',
      args: [],
      env: {},
      url: 'https://mcp.example.com',
      headers: {},
    };
    const grant = { scope: null, authorizedAt: null, error: null };
    const manual = initialMcpServerForm({
      ...base,
      oauth: { state: 'connected', clientId: 'mine', clientIdIsManual: true, ...grant },
    });
    const registered = initialMcpServerForm({
      ...base,
      oauth: { state: 'connected', clientId: 'dcr-123', clientIdIsManual: false, ...grant },
    });
    expect(manual.oauthClientId).toBe('mine');
    expect(registered.oauthClientId).toBe('');
  });
});

describe('buildMcpServerInput', () => {
  const stdioForm = { ...initialMcpServerForm(), name: 'memory', command: 'npx' };
  const httpForm = {
    ...initialMcpServerForm(),
    name: 'remote',
    serverType: 'http' as const,
    url: 'https://mcp.example.com',
  };

  it('requires a name', () => {
    expect(buildMcpServerInput({ ...stdioForm, name: '' }, undefined)).toEqual({
      ok: false,
      error: 'Name is required',
    });
  });

  it('requires a command for stdio servers', () => {
    expect(buildMcpServerInput({ ...stdioForm, command: '' }, undefined)).toEqual({
      ok: false,
      error: 'Command is required',
    });
  });

  it('requires a URL for remote servers', () => {
    expect(buildMcpServerInput({ ...httpForm, url: '' }, undefined)).toEqual({
      ok: false,
      error: 'URL is required',
    });
  });

  it('builds a stdio server, splitting args on any whitespace and omitting empty env', () => {
    expect(buildMcpServerInput({ ...stdioForm, args: '  -y   pkg\t--flag ' }, undefined)).toEqual({
      ok: true,
      input: { name: 'memory', type: 'stdio', command: 'npx', args: ['-y', 'pkg', '--flag'] },
    });
  });

  it('ignores remote-only fields on a stdio server', () => {
    const result = buildMcpServerInput(
      {
        ...stdioForm,
        url: 'https://stale.example.com',
        headers: [{ key: 'X', value: 'y', isSecret: false }],
      },
      undefined
    );
    expect(result).toEqual({
      ok: true,
      input: { name: 'memory', type: 'stdio', command: 'npx', args: [] },
    });
  });

  it('keeps an untouched stored secret env var as an empty value', () => {
    const existing: McpServer = {
      id: '1',
      authType: 'headers',
      name: 'memory',
      type: 'stdio',
      command: 'npx',
      args: [],
      env: { TOKEN: { value: '••••••••', isSecret: true } },
      headers: {},
    };
    const result = buildMcpServerInput(initialMcpServerForm(existing), existing);
    expect(result).toEqual({
      ok: true,
      input: expect.objectContaining({ env: { TOKEN: { value: '', isSecret: true } } }),
    });
  });

  it('passes through env var validation errors', () => {
    const result = buildMcpServerInput(
      { ...stdioForm, envVars: [{ key: '', value: 'orphan', isSecret: false }] },
      undefined
    );
    expect(result).toEqual({ ok: false, error: 'Every environment variable needs a name' });
  });

  it('passes through header validation errors', () => {
    const result = buildMcpServerInput(
      { ...httpForm, headers: [{ key: 'X-Key', value: '', isSecret: false }] },
      undefined
    );
    expect(result).toEqual({ ok: false, error: 'The header "X-Key" needs a value' });
  });

  it('builds a header-authenticated remote server without OAuth config', () => {
    const result = buildMcpServerInput(
      { ...httpForm, headers: [{ key: 'X-Key', value: 'v', isSecret: true }] },
      undefined
    );
    expect(result).toEqual({
      ok: true,
      input: {
        name: 'remote',
        type: 'http',
        url: 'https://mcp.example.com',
        headers: { 'X-Key': { value: 'v', isSecret: true } },
        authType: 'headers',
        oauth: undefined,
      },
    });
  });

  it('trims OAuth client ID and scope but sends the secret verbatim', () => {
    const result = buildMcpServerInput(
      {
        ...httpForm,
        serverType: 'sse',
        authType: 'oauth',
        oauthClientId: '  client  ',
        oauthClientSecret: ' secret ',
        oauthScope: ' read write ',
      },
      undefined
    );
    expect(result).toEqual({
      ok: true,
      input: {
        name: 'remote',
        type: 'sse',
        url: 'https://mcp.example.com',
        headers: undefined,
        authType: 'oauth',
        oauth: { clientId: 'client', clientSecret: ' secret ', scope: 'read write' },
      },
    });
  });
});
