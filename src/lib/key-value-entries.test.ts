import { describe, it, expect } from 'vitest';
import {
  buildKeyValueRecord,
  keepsStoredSecret,
  type KeyValueEntry,
  type SecretValueMap,
} from './key-value-entries';

const MASK = '••••••••';
const storedSecret: SecretValueMap = { Authorization: { value: MASK, isSecret: true } };

function entry(overrides: Partial<KeyValueEntry> = {}): KeyValueEntry {
  return { key: 'Authorization', value: '', isSecret: true, ...overrides };
}

describe('keepsStoredSecret', () => {
  it('is true only for a stored secret that stays secret', () => {
    expect(keepsStoredSecret({ isSecret: true }, true)).toBe(true);
    expect(keepsStoredSecret({ isSecret: true }, false)).toBe(false);
    expect(keepsStoredSecret({ isSecret: false }, true)).toBe(false);
    expect(keepsStoredSecret(undefined, true)).toBe(false);
  });
});

describe('buildKeyValueRecord', () => {
  it('keeps a blank value for an untouched stored secret', () => {
    expect(buildKeyValueRecord([entry()], storedSecret, 'header')).toEqual({
      ok: true,
      record: { Authorization: { value: '', isSecret: true } },
    });
  });

  it('rejects blanking a stored secret that is being demoted to plain text', () => {
    expect(buildKeyValueRecord([entry({ isSecret: false })], storedSecret, 'header')).toEqual({
      ok: false,
      error: 'The header "Authorization" needs a value',
    });
  });

  it('rejects a cleared plain value rather than storing an empty string', () => {
    const existing: SecretValueMap = { 'X-Api-Version': { value: '2', isSecret: false } };
    const entries = [entry({ key: 'X-Api-Version', isSecret: false })];

    expect(buildKeyValueRecord(entries, existing, 'header')).toEqual({
      ok: false,
      error: 'The header "X-Api-Version" needs a value',
    });
  });

  it('rejects a blank value for a brand new secret, which has nothing stored to keep', () => {
    expect(
      buildKeyValueRecord([entry({ key: 'TOKEN' })], undefined, 'environment variable')
    ).toEqual({ ok: false, error: 'The environment variable "TOKEN" needs a value' });
  });

  it('rejects a value with no name instead of dropping the row', () => {
    const entries = [entry({ key: '', value: 'orphan', isSecret: false })];

    expect(buildKeyValueRecord(entries, undefined, 'header')).toEqual({
      ok: false,
      error: 'Every header needs a name',
    });
  });

  it('rejects duplicate names instead of letting the last row win', () => {
    const entries = [
      entry({ key: 'X-Token', value: 'a', isSecret: false }),
      entry({ key: 'X-Token', value: 'b', isSecret: false }),
    ];

    expect(buildKeyValueRecord(entries, undefined, 'header')).toEqual({
      ok: false,
      error: 'Duplicate header "X-Token"',
    });
  });

  it('drops rows that were added and never filled in', () => {
    const entries = [
      entry({ key: 'X-Token', value: 'a', isSecret: false }),
      { key: '', value: '', isSecret: false },
    ];

    expect(buildKeyValueRecord(entries, undefined, 'header')).toEqual({
      ok: true,
      record: { 'X-Token': { value: 'a', isSecret: false } },
    });
  });

  it('passes a retyped secret through verbatim', () => {
    const entries = [entry({ value: 'Bearer new' })];

    expect(buildKeyValueRecord(entries, storedSecret, 'header')).toEqual({
      ok: true,
      record: { Authorization: { value: 'Bearer new', isSecret: true } },
    });
  });
});
