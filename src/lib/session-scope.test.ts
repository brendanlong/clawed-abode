import { describe, it, expect } from 'vitest';
import {
  childScopePattern,
  childScopeUnitName,
  CLAUDE_BIN_ENV,
  SESSION_SCOPE_ENV,
  SESSION_SCOPE_LAUNCHER,
  SESSIONS_SLICE_ENV,
  sessionScopeUnitName,
  sessionsSliceProperties,
} from './session-scope';

describe('sessionsSliceProperties', () => {
  it('assigns the memory and swap caps and the CPU quota', () => {
    expect(
      sessionsSliceProperties({ memoryMax: '85%', memorySwapMax: '0', cpuQuota: '2200%' })
    ).toEqual(['MemoryMax=85%', 'MemorySwapMax=0', 'CPUQuota=2200%']);
  });

  it('resets the CPU quota when unset so a previously applied cap is cleared', () => {
    expect(sessionsSliceProperties({ memoryMax: '64G', memorySwapMax: '0' })).toContain(
      'CPUQuota='
    );
  });
});

describe('sessionScopeUnitName', () => {
  it('builds a scope unit name from the session id and nonce', () => {
    expect(sessionScopeUnitName('abc-123', 'deadbeef')).toBe(
      'clawed-session-abc-123-deadbeef.scope'
    );
  });

  it('produces a distinct unit name per nonce so a stop→start does not collide', () => {
    const a = sessionScopeUnitName('sess', 'aaaa0000');
    const b = sessionScopeUnitName('sess', 'bbbb0000');
    expect(a).not.toBe(b);
    expect(a.endsWith('.scope')).toBe(true);
  });
});

describe('child scopes', () => {
  it('name units under the session scope, matched by its pattern and no other session’s', () => {
    const session = sessionScopeUnitName('sess', 'aaaa0000');
    const child = childScopeUnitName(session, 'n1');
    expect(child).toBe('clawed-session-sess-aaaa0000-child-n1.scope');
    const matches = (unit: string) =>
      new RegExp(`^${childScopePattern(session).replace('*', '.*')}$`).test(unit);
    expect(matches(child)).toBe(true);
    expect(matches(session)).toBe(false);
    expect(matches(childScopeUnitName(sessionScopeUnitName('sess', 'bbbb0000'), 'n1'))).toBe(false);
  });
});

describe('SESSION_SCOPE_LAUNCHER', () => {
  it('runs the real CLI under a systemd user scope when the scope env is set', () => {
    expect(SESSION_SCOPE_LAUNCHER).toContain('#!/bin/bash');
    expect(SESSION_SCOPE_LAUNCHER).toContain('args=(--user --scope --collect --quiet');
    expect(SESSION_SCOPE_LAUNCHER).toContain(
      `exec systemd-run "\${args[@]}" --unit="$${SESSION_SCOPE_ENV}"`
    );
    expect(SESSION_SCOPE_LAUNCHER).toContain(`exec "$${CLAUDE_BIN_ENV}" "$@"`);
  });

  it('places the scope in the shared slice and survives an OOM kill inside it', () => {
    expect(SESSION_SCOPE_LAUNCHER).toContain(`args+=("--slice=$${SESSIONS_SLICE_ENV}")`);
    expect(SESSION_SCOPE_LAUNCHER).toContain('-p OOMPolicy=continue');
  });

  it('gates scoping on the scope env and a probe scope with the same properties', () => {
    expect(SESSION_SCOPE_LAUNCHER).toContain(`[ -n "$${SESSION_SCOPE_ENV}" ]`);
    // Actually create-and-collect a throwaway scope so a runtime failure (no bus,
    // no delegation, an unsupported property) degrades to unwrapped rather than a
    // non-recoverable exec.
    expect(SESSION_SCOPE_LAUNCHER).toContain('systemd-run "${args[@]}" -- true');
  });
});
