import { describe, it, expect } from 'vitest';
import { z } from 'zod';
import { lenient, lenientString, parseToolInput } from './tool-input';

const schema = z.object({
  path: lenient(z.string()),
  limit: lenient(z.number()),
  mode: lenient(z.enum(['a', 'b'])),
  items: lenient(z.array(z.object({ name: lenientString }))),
});

describe('parseToolInput', () => {
  it('returns the parsed fields and strips unknown keys', () => {
    expect(parseToolInput({ path: 'x', limit: 3, extra: true }, schema)).toEqual({
      path: 'x',
      limit: 3,
    });
  });

  it('keeps the good fields when one field has the wrong type', () => {
    expect(parseToolInput({ path: 'x', limit: '3', mode: 'z' }, schema)).toEqual({ path: 'x' });
  });

  it('degrades a bad nested item field instead of dropping the array', () => {
    expect(parseToolInput({ items: [{ name: 1 }, { name: 'ok' }] }, schema)).toEqual({
      items: [{ name: '' }, { name: 'ok' }],
    });
  });

  it('returns undefined for non-object input (e.g. a still-streaming call)', () => {
    expect(parseToolInput(undefined, schema)).toBeUndefined();
    expect(parseToolInput('text', schema)).toBeUndefined();
    expect(parseToolInput({}, schema)).toEqual({});
  });
});
