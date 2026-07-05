import { describe, it, expect } from 'vitest';
import {
  reserveInitialAttachments,
  resolveInitialAttachments,
  awaitInitialAttachments,
  clearInitialAttachments,
} from './initial-attachments';

// Each test uses a distinct session id so the module-level map doesn't leak
// state between cases.
describe('initial-attachments rendezvous', () => {
  it('returns stored names when resolved before the await (common case)', async () => {
    const id = 'session-resolve-first';
    reserveInitialAttachments(id);
    resolveInitialAttachments(id, ['a.png', 'b.md']);

    const result = await awaitInitialAttachments(id, 1000);
    expect(result).toEqual(['a.png', 'b.md']);
  });

  it('returns stored names when resolved after the await starts', async () => {
    const id = 'session-await-first';
    reserveInitialAttachments(id);

    const pending = awaitInitialAttachments(id, 1000);
    resolveInitialAttachments(id, ['late.txt']);

    expect(await pending).toEqual(['late.txt']);
  });

  it('returns an empty array when the timeout elapses first', async () => {
    const id = 'session-timeout';
    reserveInitialAttachments(id);

    const result = await awaitInitialAttachments(id, 5);
    expect(result).toEqual([]);
  });

  it('returns an empty array when no slot was reserved', async () => {
    const result = await awaitInitialAttachments('session-never-reserved', 1000);
    expect(result).toEqual([]);
  });

  it('resolve is a no-op when no slot was reserved', async () => {
    // Should not throw; a later await still returns [] because the slot is gone.
    resolveInitialAttachments('session-no-reserve', ['x']);
    const result = await awaitInitialAttachments('session-no-reserve', 5);
    expect(result).toEqual([]);
  });

  it('clear drops the reservation so a later await returns []', async () => {
    const id = 'session-cleared';
    reserveInitialAttachments(id);
    clearInitialAttachments(id);

    const result = await awaitInitialAttachments(id, 5);
    expect(result).toEqual([]);
  });

  it('consumes the slot so a second await returns []', async () => {
    const id = 'session-consumed';
    reserveInitialAttachments(id);
    resolveInitialAttachments(id, ['once.png']);

    expect(await awaitInitialAttachments(id, 1000)).toEqual(['once.png']);
    expect(await awaitInitialAttachments(id, 5)).toEqual([]);
  });
});
