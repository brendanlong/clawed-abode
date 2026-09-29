import { describe, it, expect } from 'vitest';
import { uuidV5 } from './uuid-v5';

const URL_NAMESPACE = '6ba7b810-9dad-11d1-80b4-00c04fd430c8';

// Expected values were computed with the `uuid` package's v5(). Existing message
// ids in the DB were generated with it, so these must match exactly.
describe('uuidV5', () => {
  it.each([
    ['', '4ebd0208-8328-5d69-8c44-ec50939c0967'],
    ['hello', '9342d47a-1bab-5709-9869-c840b2eac501'],
    ['sess-1:tool_result:toolu_01ABC', '8fd27cc2-0482-5ffb-9994-4b33bd2b20c4'],
    [
      'abc:error:1700000000000:Something failed — ünïcödé 🎉',
      'd9867b18-4b65-588d-97e0-bc95e429d86d',
    ],
  ])('matches uuid v5 for %j', (name, expected) => {
    expect(uuidV5(name, URL_NAMESPACE)).toBe(expected);
  });

  it('depends on the namespace', () => {
    expect(uuidV5('hello', '6ba7b811-9dad-11d1-80b4-00c04fd430c8')).toBe(
      '074171de-bc84-5ea4-b636-1135477620e1'
    );
  });

  it('rejects a malformed namespace', () => {
    expect(() => uuidV5('hello', 'not-a-uuid')).toThrow();
  });
});
