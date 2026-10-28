import { describe, it, expect } from 'vitest';
import { redactSecrets, redactSecretsDeep } from './secret-redaction';

// Assembled at runtime so this file doesn't itself trip secret scanners.
const ANTHROPIC_KEY = ['sk-ant-api03', 'x'.repeat(93) + 'AA'].join('-');
const GITHUB_TOKEN = 'ghp' + '_' + 'A1b2C3d4'.repeat(4) + 'E5f6';
const PRIVATE_KEY = [
  '-----BEGIN RSA PRIVATE KEY-----',
  'MIIEowIBAAKCAQEA' + 'q7Vb3Fz9'.repeat(40),
  '-----END RSA PRIVATE KEY-----',
].join('\n');

describe('redactSecrets', () => {
  it('passes text without secrets through unchanged', async () => {
    const text = 'commit 3f2a9c1d8e7b6a5f4e3d2c1b0a9f8e7d6c5b4a39 and sha256 ' + 'ab'.repeat(32);
    expect(await redactSecrets(text)).toEqual({ text, rules: [] });
  });

  it('replaces a provider key with a marker naming the rule', async () => {
    const { text, rules } = await redactSecrets(`ANTHROPIC_API_KEY=${ANTHROPIC_KEY}\nnext line`);
    expect(text).toBe('ANTHROPIC_API_KEY=[REDACTED:anthropic]\nnext line');
    expect(rules).toEqual(['anthropic']);
  });

  it('redacts several secrets in one string', async () => {
    const { text, rules } = await redactSecrets(`a ${ANTHROPIC_KEY} b ${GITHUB_TOKEN} c`);
    expect(text).toBe('a [REDACTED:anthropic] b [REDACTED:github] c');
    expect(rules.sort()).toEqual(['anthropic', 'github']);
  });

  it('redacts a PEM private key without touching surrounding text', async () => {
    const { text } = await redactSecrets(`before\n${PRIVATE_KEY}\nafter`);
    expect(text).toBe('before\n[REDACTED:privatekey]\nafter');
  });

  it('leaves a PEM header whose body is not a key alone', async () => {
    const text =
      '-----BEGIN RSA PRIVATE KEY-----\nexplain the format here\n-----END RSA PRIVATE KEY-----';
    expect((await redactSecrets(text)).text).toBe(text);
  });

  it('cannot be switched off by a secretlint-disable comment in the text', async () => {
    const { text } = await redactSecrets(`# secretlint-disable\nTOKEN=${GITHUB_TOKEN}`);
    expect(text).toBe('# secretlint-disable\nTOKEN=[REDACTED:github]');
  });

  it('redacts a token inside a URL but leaves placeholder credentials', async () => {
    const { text } = await redactSecrets(
      `https://x-access-token:${GITHUB_TOKEN}@github.com/o/r and https://user:pass@example.com/cb`
    );
    expect(text).toBe(
      'https://x-access-token:[REDACTED:github]@github.com/o/r and https://user:pass@example.com/cb'
    );
  });
});

describe('redactSecretsDeep', () => {
  it('redacts string leaves and keeps the structure', async () => {
    const content = {
      type: 'user',
      message: { content: [{ type: 'tool_result', content: `token: ${GITHUB_TOKEN}`, n: 1 }] },
    };
    const { value, rules } = await redactSecretsDeep(content);
    expect(value).toEqual({
      type: 'user',
      message: { content: [{ type: 'tool_result', content: 'token: [REDACTED:github]', n: 1 }] },
    });
    expect(rules).toEqual(['github']);
  });

  it('returns the original value when nothing matched', async () => {
    const content = { text: 'hello' };
    expect((await redactSecretsDeep(content)).value).toBe(content);
  });
});
