import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createLogger, isLogLevelEnabled } from './logger';
import { resetEnvCache } from './env';

describe('isLogLevelEnabled', () => {
  it('allows the threshold level and anything more severe', () => {
    expect(isLogLevelEnabled('debug', 'info')).toBe(false);
    expect(isLogLevelEnabled('info', 'info')).toBe(true);
    expect(isLogLevelEnabled('warn', 'info')).toBe(true);
    expect(isLogLevelEnabled('error', 'info')).toBe(true);
    expect(isLogLevelEnabled('debug', 'debug')).toBe(true);
    expect(isLogLevelEnabled('warn', 'error')).toBe(false);
  });
});

describe('createLogger', () => {
  const originalLevel = process.env.LOG_LEVEL;

  beforeEach(() => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
    if (originalLevel === undefined) delete process.env.LOG_LEVEL;
    else process.env.LOG_LEVEL = originalLevel;
    resetEnvCache();
  });

  it('drops debug entries at the default info level', () => {
    delete process.env.LOG_LEVEL;
    resetEnvCache();
    const log = createLogger('test');
    log.debug('hidden');
    log.info('shown');
    expect(console.log).toHaveBeenCalledTimes(1);
    expect(console.log).toHaveBeenCalledWith(expect.stringContaining('[INFO ] [test] shown'));
  });

  it('writes debug entries when LOG_LEVEL=debug', () => {
    process.env.LOG_LEVEL = 'debug';
    resetEnvCache();
    createLogger('test').debug('visible', { a: 1 });
    expect(console.log).toHaveBeenCalledWith(
      expect.stringContaining('[DEBUG] [test] visible {"a":1}')
    );
  });

  it('routes warn and error to their console streams and includes the error message', () => {
    process.env.LOG_LEVEL = 'warn';
    resetEnvCache();
    const log = createLogger('test');
    log.info('hidden');
    log.warn('careful');
    log.error('boom', new Error('kaboom'));
    expect(console.log).not.toHaveBeenCalled();
    expect(console.warn).toHaveBeenCalledWith(expect.stringContaining('[WARN ] [test] careful'));
    expect(console.error).toHaveBeenCalledWith(expect.stringContaining('Error: Error: kaboom'));
  });
});
