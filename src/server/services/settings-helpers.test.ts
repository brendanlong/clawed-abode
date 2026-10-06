import { resetEnvCache } from '@/lib/env';
import { describe, it, expect, beforeAll } from 'vitest';
import { decrypt, encrypt } from '@/lib/crypto';
import {
  decryptEnvVars,
  decryptMcpServers,
  formatEnvVarsForDisplay,
  formatMcpServersForDisplay,
  mcpServerHasSecrets,
  planMcpServerWrite,
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

    it('groups MCP server values into env and headers, masking secrets', () => {
      const [stdio, http] = formatMcpServersForDisplay([
        {
          id: '1',
          name: 's',
          type: 'stdio',
          command: 'node',
          args: JSON.stringify(['a.js']),
          url: null,
          authType: 'headers',
          values: [
            { kind: 'env', name: 'K', value: encrypt('x'), isSecret: true },
            { kind: 'env', name: 'D', value: '1', isSecret: false },
          ],
          oauth: null,
        },
        {
          id: '2',
          name: 'h',
          type: 'http',
          command: '',
          args: null,
          url: 'https://x',
          authType: 'headers',
          values: [{ kind: 'header', name: 'Authorization', value: encrypt('t'), isSecret: true }],
          oauth: null,
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
          url: null,
          authType: 'headers',
          values: [{ kind: 'env', name: 'K', value: encrypt('x'), isSecret: true }],
          oauth: null,
        },
        {
          id: '2',
          name: 'h',
          type: 'sse',
          command: '',
          args: null,
          url: 'https://x',
          authType: 'headers',
          values: [{ kind: 'header', name: 'A', value: 'plain', isSecret: false }],
          oauth: null,
        },
        {
          id: '3',
          name: 'b',
          type: 'http',
          command: '',
          args: null,
          url: 'https://y',
          authType: 'headers',
          values: [],
          oauth: null,
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

  describe('corrupt MCP server rows', () => {
    const row = {
      id: '1',
      name: 'bad',
      type: 'http',
      command: '',
      args: null,
      url: 'https://x',
      authType: 'headers',
      values: [],
      oauth: null,
    };

    it.each([
      ['an unknown type', { type: 'ws' }],
      ['an unknown auth type', { authType: 'basic' }],
      ['an http server without a URL', { url: null }],
      ['stdio args that are not a string array', { type: 'stdio', args: '[1]' }],
      ['stdio args that are not JSON', { type: 'stdio', args: 'not json' }],
    ])('throws on %s, naming the server', (_, patch) => {
      expect(() => formatMcpServersForDisplay([{ ...row, ...patch }])).toThrow(/"bad"/);
      expect(() => decryptMcpServers([{ ...row, ...patch }])).toThrow(/"bad"/);
    });
  });

  describe('planMcpServerWrite', () => {
    it('encrypts secrets and keeps empty secrets out of the values to write', () => {
      const plan = planMcpServerWrite({
        name: 's',
        type: 'stdio',
        command: 'node',
        env: {
          TOKEN: { value: '', isSecret: true },
          NEW: { value: 'n', isSecret: true },
          PLAIN: { value: 'p', isSecret: false },
          BLANK: { value: '', isSecret: false },
        },
      });
      expect(plan.kind).toBe('env');
      expect(plan.keep).toEqual(['TOKEN']);
      expect(plan.values.map((v) => v.name)).toEqual(['NEW', 'PLAIN', 'BLANK']);
      expect(plan.values[0].isSecret).toBe(true);
      expect(decrypt(plan.values[0].value)).toBe('n');
      expect(plan.values.slice(1)).toEqual([
        { name: 'PLAIN', value: 'p', isSecret: false },
        { name: 'BLANK', value: '', isSecret: false },
      ]);
      expect(plan.row).toEqual({
        type: 'stdio',
        command: 'node',
        args: null,
        url: null,
        authType: 'headers',
      });
    });

    it('writes headers for http and clears the stdio fields', () => {
      const plan = planMcpServerWrite({
        name: 'h',
        type: 'http',
        url: 'https://x',
        authType: 'oauth',
        headers: { A: { value: 'v', isSecret: false } },
      });
      expect(plan).toEqual({
        row: { type: 'http', command: '', args: null, url: 'https://x', authType: 'oauth' },
        kind: 'header',
        values: [{ name: 'A', value: 'v', isSecret: false }],
        keep: [],
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
