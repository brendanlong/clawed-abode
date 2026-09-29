import { describe, it, expect } from 'vitest';
import { initialMcpServerForm } from './mcp-server-form';

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
