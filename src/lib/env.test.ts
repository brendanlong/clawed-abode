import { describe, it, expect, afterEach } from 'vitest';
import { env, getEnv, resetEnvCache } from './env';

const SAVED = { ...process.env };

function restoreEnv() {
  for (const key of Object.keys(process.env)) {
    if (!(key in SAVED)) delete process.env[key];
  }
  Object.assign(process.env, SAVED);
  resetEnvCache();
}

describe('env', () => {
  afterEach(restoreEnv);

  it('caches the parsed env until reset', () => {
    process.env.CLAUDE_MODEL = 'first';
    resetEnvCache();
    expect(env.CLAUDE_MODEL).toBe('first');

    process.env.CLAUDE_MODEL = 'second';
    expect(env.CLAUDE_MODEL).toBe('first');

    resetEnvCache();
    expect(env.CLAUDE_MODEL).toBe('second');
  });

  it('base64-decodes PASSWORD_HASH', () => {
    process.env.PASSWORD_HASH = Buffer.from('$argon2id$hash').toString('base64');
    resetEnvCache();
    expect(env.PASSWORD_HASH).toBe('$argon2id$hash');
  });

  it('defaults LOG_LEVEL to info and rejects unknown levels', () => {
    delete process.env.LOG_LEVEL;
    resetEnvCache();
    expect(env.LOG_LEVEL).toBe('info');

    process.env.LOG_LEVEL = 'verbose';
    resetEnvCache();
    expect(() => getEnv()).toThrow(/LOG_LEVEL/);
  });

  it('lists every invalid field in the error', () => {
    process.env.LOG_LEVEL = 'verbose';
    process.env.ENCRYPTION_KEY = 'short';
    resetEnvCache();
    expect(() => getEnv()).toThrow(/LOG_LEVEL[\s\S]*ENCRYPTION_KEY|ENCRYPTION_KEY[\s\S]*LOG_LEVEL/);
  });
});
