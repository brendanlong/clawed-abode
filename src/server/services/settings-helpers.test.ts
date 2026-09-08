import { resetEnvCache } from '@/lib/env';
import { describe, it, expect, beforeAll } from 'vitest';
import { encrypt } from '@/lib/crypto';
import {
  buildMcpServerData,
  decryptEnvVars,
  decryptMcpServers,
  formatEnvVarsForDisplay,
  formatMcpServersForDisplay,
  mcpServerHasSecrets,
} from './settings-helpers';

const MASK = '••••••••';

describe('settings-helpers', () => {
  beforeAll(() => {
    process.env.ENCRYPTION_KEY = 'unit-test-encryption-key-that-is-long-enough';
    resetEnvCache();
  });

  describe('display formatting', () => {
    it('masks secret env vars and leaves plain ones readable', () => {
      const rows = [
        { id: '1', name: 'PLAIN', value: 'v', isSecret: false },
        { id: '2', name: 'SECRET', value: encrypt('s'), isSecret: true },
      ];
      expect(formatEnvVarsForDisplay(rows)).toEqual([
        { id: '1', name: 'PLAIN', value: 'v', isSecret: false },
        { id: '2', name: 'SECRET', value: MASK, isSecret: true },
      ]);
    });

    it('parses MCP server JSON columns, masking secret env and header values', () => {
      const [stdio, http] = formatMcpServersForDisplay([
        {
          id: '1',
          name: 's',
          type: 'stdio',
          command: 'node',
          args: JSON.stringify(['a.js']),
          env: JSON.stringify({
            K: { value: encrypt('x'), isSecret: true },
            D: { value: '1', isSecret: false },
          }),
          url: null,
          headers: null,
          authType: 'headers',
        },
        {
          id: '2',
          name: 'h',
          type: 'http',
          command: '',
          args: null,
          env: null,
          url: 'https://x',
          headers: JSON.stringify({ Authorization: { value: encrypt('t'), isSecret: true } }),
          authType: 'headers',
        },
      ]);
      expect(stdio).toMatchObject({
        args: ['a.js'],
        env: { K: { value: MASK, isSecret: true }, D: { value: '1', isSecret: false } },
        headers: {},
      });
      expect(http).toMatchObject({
        url: 'https://x',
        args: [],
        env: {},
        headers: { Authorization: { value: MASK, isSecret: true } },
      });
    });
  });

  describe('decryption for the runner', () => {
    it('decrypts secret env vars and drops the isSecret flag', () => {
      expect(
        decryptEnvVars([
          { name: 'A', value: encrypt('s'), isSecret: true },
          { name: 'B', value: 'p', isSecret: false },
        ])
      ).toEqual([
        { name: 'A', value: 's' },
        { name: 'B', value: 'p' },
      ]);
    });

    it('decrypts stdio env and http headers, omitting empty maps', () => {
      const [stdio, http, bare] = decryptMcpServers([
        {
          id: '1',
          name: 's',
          type: 'stdio',
          command: 'node',
          args: JSON.stringify(['a']),
          env: JSON.stringify({ K: { value: encrypt('x'), isSecret: true } }),
          url: null,
          headers: null,
          authType: 'headers',
        },
        {
          id: '2',
          name: 'h',
          type: 'sse',
          command: '',
          args: null,
          env: null,
          url: 'https://x',
          headers: JSON.stringify({ A: { value: 'plain', isSecret: false } }),
          authType: 'headers',
        },
        {
          id: '3',
          name: 'b',
          type: 'http',
          command: '',
          args: null,
          env: null,
          url: 'https://y',
          headers: null,
          authType: 'headers',
        },
      ]);
      expect(stdio).toEqual({
        name: 's',
        type: 'stdio',
        command: 'node',
        args: ['a'],
        env: { K: 'x' },
      });
      expect(http).toEqual({ name: 'h', type: 'sse', url: 'https://x', headers: { A: 'plain' } });
      expect(bare).toEqual({ name: 'b', type: 'http', url: 'https://y', headers: undefined });
    });
  });

  describe('buildMcpServerData', () => {
    it('encrypts new secrets and keeps an unchanged secret (empty value) from the existing row', () => {
      const existing = {
        env: JSON.stringify({ TOKEN: { value: encrypt('old'), isSecret: true } }),
        headers: null,
      };
      const data = buildMcpServerData(
        {
          name: 's',
          type: 'stdio',
          command: 'node',
          env: {
            TOKEN: { value: '', isSecret: true },
            NEW: { value: 'n', isSecret: true },
            PLAIN: { value: 'p', isSecret: false },
          },
        },
        existing
      );
      const env = JSON.parse(data.env!) as Record<string, { value: string; isSecret: boolean }>;
      expect(env.TOKEN).toEqual(JSON.parse(existing.env!).TOKEN);
      expect(env.NEW.value).not.toBe('n');
      expect(env.PLAIN).toEqual({ value: 'p', isSecret: false });
      expect(data).toMatchObject({ type: 'stdio', url: null, headers: null, args: null });
    });

    it('re-encrypts when the existing value was not a secret, and clears stdio fields for http', () => {
      const data = buildMcpServerData(
        {
          name: 'h',
          type: 'http',
          url: 'https://x',
          authType: 'headers',
          headers: { A: { value: '', isSecret: true } },
        },
        { env: null, headers: JSON.stringify({ A: { value: 'was-plain', isSecret: false } }) }
      );
      const headers = JSON.parse(data.headers!) as Record<
        string,
        { value: string; isSecret: boolean }
      >;
      expect(headers.A.isSecret).toBe(true);
      expect(headers.A.value).not.toBe('was-plain');
      expect(data).toMatchObject({
        type: 'http',
        command: '',
        args: null,
        env: null,
        url: 'https://x',
      });
    });
  });

  it('mcpServerHasSecrets looks at env for stdio and headers for http', () => {
    expect(
      mcpServerHasSecrets({
        name: 's',
        type: 'stdio',
        command: 'c',
        env: { A: { value: 'v', isSecret: true } },
      })
    ).toBe(true);
    expect(mcpServerHasSecrets({ name: 's', type: 'stdio', command: 'c' })).toBe(false);
    expect(
      mcpServerHasSecrets({
        name: 'h',
        type: 'http',
        url: 'https://x',
        authType: 'headers',
        headers: { A: { value: 'v', isSecret: false } },
      })
    ).toBe(false);
  });
});
