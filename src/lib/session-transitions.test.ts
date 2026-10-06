import { describe, it, expect } from 'vitest';
import { ALLOWED_FROM, type SessionTransition } from './session-transitions';
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

  it('starts only stopped or errored sessions', () => {
    expect([...ALLOWED_FROM.start].sort()).toEqual(['error', 'stopped']);
  });

  it('leaves a creating session to its setup rather than stopping it', () => {
    expect(ALLOWED_FROM.stop).not.toContain('creating');
    expect(ALLOWED_FROM.setupComplete).toEqual(['creating']);
    expect(ALLOWED_FROM.setupFailed).toEqual(['creating']);
  });
});
