import { describe, it, expect } from 'vitest';
import {
  BACKGROUND_REAPER_MARKER,
  computeBackgroundBashRewrite,
  isAlreadyWrapped,
  isBackgroundBashToWrap,
  wrapBackgroundCommand,
} from './background-command';

/**
 * Pull the base64 payload back out of a wrapped command and decode it. It is the
 * single long base64-only quoted token (the positional arg to the scope launcher).
 */
function decodeEmbeddedCommand(wrapped: string): string {
  const match = wrapped.match(/'([A-Za-z0-9+/=]{16,})'/);
  if (!match) throw new Error('no base64 payload found in wrapped command');
  return Buffer.from(match[1], 'base64').toString('utf8');
}

describe('wrapBackgroundCommand', () => {
  it('wraps with a systemd user scope and a teardown trap', () => {
    const wrapped = wrapBackgroundCommand('echo hi');
    expect(wrapped).toContain(BACKGROUND_REAPER_MARKER);
    expect(wrapped).toContain('systemd-run --user --scope --collect --quiet');
    expect(wrapped).toContain('systemctl --user stop');
    expect(wrapped).toContain("trap '__ca_reap; exit 143' TERM INT HUP");
  });

  it('preserves the exact original command bytes via base64 (no quoting hazard)', () => {
    const tricky = `echo "it's a $VAR"; trap 'cleanup' EXIT && printf '%s\\n' 'done'`;
    expect(decodeEmbeddedCommand(wrapBackgroundCommand(tricky))).toBe(tricky);
  });

  it('produces a command that is detected as already wrapped (idempotency)', () => {
    expect(isAlreadyWrapped(wrapBackgroundCommand('echo hi'))).toBe(true);
  });
});

describe('isBackgroundBashToWrap', () => {
  it('is true for a non-empty backgrounded Bash command', () => {
    expect(
      isBackgroundBashToWrap('Bash', { command: 'pnpm services', run_in_background: true })
    ).toBe(true);
  });

  it('is false for a foreground Bash command', () => {
    expect(isBackgroundBashToWrap('Bash', { command: 'ls', run_in_background: false })).toBe(false);
    expect(isBackgroundBashToWrap('Bash', { command: 'ls' })).toBe(false);
  });

  it('is false for non-Bash tools', () => {
    expect(isBackgroundBashToWrap('Read', { command: 'ls', run_in_background: true })).toBe(false);
  });

  it('is false for an empty/whitespace command', () => {
    expect(isBackgroundBashToWrap('Bash', { command: '   ', run_in_background: true })).toBe(false);
  });

  it('is false for malformed input', () => {
    expect(isBackgroundBashToWrap('Bash', { run_in_background: true })).toBe(false);
    expect(isBackgroundBashToWrap('Bash', null)).toBe(false);
    expect(isBackgroundBashToWrap('Bash', 'not an object')).toBe(false);
  });

  it('is false for an already-wrapped command (no double wrapping)', () => {
    const wrapped = wrapBackgroundCommand('pnpm services');
    expect(isBackgroundBashToWrap('Bash', { command: wrapped, run_in_background: true })).toBe(
      false
    );
  });
});

describe('computeBackgroundBashRewrite', () => {
  it('overrides only command and preserves other tool-input fields', () => {
    const input = {
      command: 'pnpm services',
      run_in_background: true,
      description: 'start services',
      timeout: 600000,
    };
    const rewrite = computeBackgroundBashRewrite('Bash', input);
    expect(rewrite).not.toBeNull();
    expect(rewrite).toMatchObject({
      run_in_background: true,
      description: 'start services',
      timeout: 600000,
    });
    expect(rewrite!.command).not.toBe('pnpm services');
    expect(decodeEmbeddedCommand(rewrite!.command as string)).toBe('pnpm services');
  });

  it('returns null when the call should not be wrapped', () => {
    expect(
      computeBackgroundBashRewrite('Bash', { command: 'ls', run_in_background: false })
    ).toBeNull();
    expect(
      computeBackgroundBashRewrite('Read', { command: 'ls', run_in_background: true })
    ).toBeNull();
  });
});
