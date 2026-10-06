import { describe, it, expect } from 'vitest';
import { ALLOWED_FROM, canTransition, type SessionTransition } from './session-transitions';
import { sessionStatusSchema } from './session-display-status';

const transitions = Object.keys(ALLOWED_FROM) as SessionTransition[];

describe('ALLOWED_FROM', () => {
  it('never writes over an archived session', () => {
    for (const transition of transitions) {
      expect(ALLOWED_FROM[transition]).not.toContain('archived');
    }
  });

  it('lets every non-archived session be archived', () => {
    expect([...ALLOWED_FROM.archive].sort()).toEqual(
      sessionStatusSchema.options.filter((s) => s !== 'archived').sort()
    );
  });

  it('starts only stopped sessions and stops only running ones', () => {
    expect(ALLOWED_FROM.start).toEqual(['stopped']);
    expect(ALLOWED_FROM.stop).toEqual(['running']);
  });

  it('lets a failed setup only be archived', () => {
    for (const transition of transitions) {
      if (transition === 'archive' || transition === 'configure') continue;
      expect(ALLOWED_FROM[transition]).not.toContain('error');
    }
  });

  it('leaves a creating session to its setup rather than stopping it', () => {
    expect(ALLOWED_FROM.stop).not.toContain('creating');
    expect(ALLOWED_FROM.setupComplete).toEqual(['creating']);
    expect(ALLOWED_FROM.setupFailed).toEqual(['creating']);
  });
});

describe('canTransition', () => {
  it('follows the table', () => {
    expect(canTransition('start', 'stopped')).toBe(true);
    expect(canTransition('start', 'error')).toBe(false);
    expect(canTransition('stop', 'running')).toBe(true);
  });

  it('refuses a status it does not know', () => {
    expect(canTransition('archive', 'hibernating')).toBe(false);
  });
});
