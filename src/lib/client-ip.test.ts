import { describe, it, expect } from 'vitest';
import { getClientIp } from './client-ip';

function headers(values: Record<string, string>) {
  return (name: string) => values[name];
}

describe('getClientIp', () => {
  it('takes the first X-Forwarded-For hop', () => {
    expect(getClientIp(headers({ 'x-forwarded-for': ' 1.2.3.4 , 10.0.0.1' }))).toBe('1.2.3.4');
  });

  it('falls back to X-Real-IP', () => {
    expect(getClientIp(headers({ 'x-forwarded-for': '', 'x-real-ip': '5.6.7.8' }))).toBe('5.6.7.8');
  });

  it('is undefined without either header', () => {
    expect(getClientIp(headers({}))).toBeUndefined();
  });
});
