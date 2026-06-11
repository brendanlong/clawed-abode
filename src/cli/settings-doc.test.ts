import { describe, it, expect, beforeAll } from 'vitest';
import type { EnvVar, McpServer } from '@prisma/client';
import { encrypt, decrypt } from '@/lib/crypto';
import {
  envVarsToDoc,
  mcpServersToDoc,
  envVarDocToDb,
  mcpServerDocToDb,
  docHasSecrets,
} from './settings-doc';

beforeAll(() => {
  process.env.ENCRYPTION_KEY = 'test-encryption-key-32-characters!!';
});

function envVarRow(overrides: Partial<EnvVar>): EnvVar {
  return {
    id: 'id',
    repoSettingsId: null,
    name: 'NAME',
    value: 'value',
    isSecret: false,
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  };
}

function mcpServerRow(overrides: Partial<McpServer>): McpServer {
  return {
    id: 'id',
    repoSettingsId: null,
    name: 'server',
    type: 'stdio',
    command: 'cmd',
    args: null,
    env: null,
    url: null,
    headers: null,
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  };
}

describe('envVars round-trip', () => {
  it('decrypts secrets into the doc and re-encrypts on save', () => {
    const rows = [
      envVarRow({ name: 'PLAIN', value: 'visible' }),
      envVarRow({ name: 'SECRET', value: encrypt('hidden'), isSecret: true }),
    ];

    const doc = envVarsToDoc(rows);
    expect(doc).toEqual([
      { name: 'PLAIN', value: 'visible', isSecret: false },
      { name: 'SECRET', value: 'hidden', isSecret: true },
    ]);

    const saved = doc.map((ev) => envVarDocToDb(ev, 'repo-id'));
    expect(saved[0]).toEqual({
      repoSettingsId: 'repo-id',
      name: 'PLAIN',
      value: 'visible',
      isSecret: false,
    });
    expect(saved[1].isSecret).toBe(true);
    expect(saved[1].value).not.toBe('hidden');
    expect(decrypt(saved[1].value)).toBe('hidden');
  });
});

describe('mcpServers round-trip', () => {
  it('round-trips stdio servers with encrypted env values', () => {
    const rows = [
      mcpServerRow({
        name: 'memory',
        command: 'npx',
        args: JSON.stringify(['mcp-server-memory']),
        env: JSON.stringify({
          API_KEY: { value: encrypt('shh'), isSecret: true },
          MODE: { value: 'fast', isSecret: false },
        }),
      }),
    ];

    const doc = mcpServersToDoc(rows);
    expect(doc).toEqual([
      {
        name: 'memory',
        type: 'stdio',
        command: 'npx',
        args: ['mcp-server-memory'],
        env: {
          API_KEY: { value: 'shh', isSecret: true },
          MODE: { value: 'fast', isSecret: false },
        },
      },
    ]);

    const saved = mcpServerDocToDb(doc[0], null);
    expect(saved.command).toBe('npx');
    expect(saved.url).toBeNull();
    const savedEnv = JSON.parse(saved.env!) as Record<string, { value: string; isSecret: boolean }>;
    expect(savedEnv.MODE).toEqual({ value: 'fast', isSecret: false });
    expect(savedEnv.API_KEY.isSecret).toBe(true);
    expect(decrypt(savedEnv.API_KEY.value)).toBe('shh');
  });

  it('round-trips http servers with encrypted headers', () => {
    const rows = [
      mcpServerRow({
        name: 'api',
        type: 'http',
        command: '',
        url: 'https://example.com/mcp',
        headers: JSON.stringify({ Authorization: { value: encrypt('Bearer x'), isSecret: true } }),
      }),
    ];

    const doc = mcpServersToDoc(rows);
    expect(doc[0]).toEqual({
      name: 'api',
      type: 'http',
      url: 'https://example.com/mcp',
      headers: { Authorization: { value: 'Bearer x', isSecret: true } },
    });

    const saved = mcpServerDocToDb(doc[0], null);
    expect(saved.command).toBe('');
    expect(saved.url).toBe('https://example.com/mcp');
    expect(saved.env).toBeNull();
    const headers = JSON.parse(saved.headers!) as Record<
      string,
      { value: string; isSecret: boolean }
    >;
    expect(decrypt(headers.Authorization.value)).toBe('Bearer x');
  });
});

describe('docHasSecrets', () => {
  it('detects secret env vars', () => {
    expect(
      docHasSecrets({
        envVars: [{ name: 'A', value: 'x', isSecret: true }],
        mcpServers: [],
      })
    ).toBe(true);
  });

  it('detects secret MCP header values', () => {
    expect(
      docHasSecrets({
        envVars: [],
        mcpServers: [
          {
            name: 's',
            type: 'http',
            url: 'https://example.com',
            headers: { Auth: { value: 'x', isSecret: true } },
          },
        ],
      })
    ).toBe(true);
  });

  it('returns false when nothing is secret', () => {
    expect(
      docHasSecrets({
        envVars: [{ name: 'A', value: 'x', isSecret: false }],
        mcpServers: [{ name: 's', type: 'stdio', command: 'cmd' }],
      })
    ).toBe(false);
  });
});
