import { describe, it, expect } from 'vitest';
import {
  CLAUDE_BIN_ENV,
  SESSION_SCOPE_ENV,
  SESSION_SCOPE_LAUNCHER,
  SESSION_SCOPE_UNIT_GLOB,
  sessionScopeUnitName,
} from './session-scope';

describe('sessionScopeUnitName', () => {
  it('builds a scope unit name from the session id and nonce', () => {
    expect(sessionScopeUnitName('abc-123', 'deadbeef')).toBe(
      'clawed-session-abc-123-deadbeef.scope'
    );
  });

  it('is matched by the sweep glob (a literal prefix + .scope suffix)', () => {
    const name = sessionScopeUnitName('sess', 'ff00');
    expect(name.startsWith('clawed-session-')).toBe(true);
    expect(name.endsWith('.scope')).toBe(true);
    expect(SESSION_SCOPE_UNIT_GLOB).toBe('clawed-session-*.scope');
  });
});

describe('SESSION_SCOPE_LAUNCHER', () => {
  it('runs the real CLI under a systemd user scope when the scope env is set', () => {
    expect(SESSION_SCOPE_LAUNCHER).toContain('#!/bin/bash');
    expect(SESSION_SCOPE_LAUNCHER).toContain('systemd-run --user --scope --collect --quiet');
    expect(SESSION_SCOPE_LAUNCHER).toContain(`--unit="$${SESSION_SCOPE_ENV}"`);
    expect(SESSION_SCOPE_LAUNCHER).toContain(`exec "$${CLAUDE_BIN_ENV}" "$@"`);
  });

  it('gates scoping on the scope env and a runtime scope-creation probe', () => {
    expect(SESSION_SCOPE_LAUNCHER).toContain(`[ -n "$${SESSION_SCOPE_ENV}" ]`);
    // Actually create-and-collect a throwaway scope so a runtime failure (no bus,
    // no delegation) degrades to unwrapped rather than a non-recoverable exec.
    expect(SESSION_SCOPE_LAUNCHER).toContain(
      'systemd-run --user --scope --collect --quiet -- true'
    );
  });
});
