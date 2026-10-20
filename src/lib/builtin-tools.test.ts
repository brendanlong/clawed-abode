import { describe, it, expect } from 'vitest';
import { attributeMessage, builtinToolsPrompt, resolveBuiltinTools } from './builtin-tools';

describe('resolveBuiltinTools', () => {
  it('gives no tools when disabled, even with session management on', () => {
    expect(
      resolveBuiltinTools({ builtinToolsEnabled: false, sessionToolsEnabled: true })
    ).toBeNull();
  });

  it('adds the management tools only when both switches are on', () => {
    expect(resolveBuiltinTools({ builtinToolsEnabled: true, sessionToolsEnabled: false })).toBe(
      'basic'
    );
    expect(resolveBuiltinTools({ builtinToolsEnabled: true, sessionToolsEnabled: true })).toBe(
      'manage'
    );
  });
});

describe('builtinToolsPrompt', () => {
  it('asks for a rename only when the name is a default', () => {
    expect(builtinToolsPrompt('basic', true)).toMatch(/auto-generated default.*rename_session/);
    expect(builtinToolsPrompt('basic', false)).toMatch(/only use rename_session if they ask/);
  });

  it('always explains how to find SendMessage addresses', () => {
    expect(builtinToolsPrompt('basic', true)).toMatch(/list_sessions.*agentName.*SendMessage/);
  });

  it('tells the agent to notify the user at every level', () => {
    expect(builtinToolsPrompt('basic', true)).toContain('notify_user');
    expect(builtinToolsPrompt('manage', false)).toContain('notify_user');
  });

  it('points the agent at the usage tools at every level', () => {
    expect(builtinToolsPrompt('basic', true)).toMatch(/check_usage.*subagents.*set_usage_alerts/);
    expect(builtinToolsPrompt('manage', false)).toContain('check_usage');
  });

  it('points the agent at watch_pull_request at every level', () => {
    expect(builtinToolsPrompt('basic', true)).toMatch(
      /watch_pull_request rather than polling gh or sleeping, then end your turn/
    );
    expect(builtinToolsPrompt('manage', false)).toContain('watch_pull_request');
  });

  it('describes the management tools only at the manage level', () => {
    expect(builtinToolsPrompt('basic', true)).not.toContain('create_session');
    expect(builtinToolsPrompt('manage', true)).toContain('create_session');
  });
});

describe('attributeMessage', () => {
  it('names the creating session and how to reach its agent', () => {
    expect(attributeMessage({ id: 'id', name: 'Boss', agentName: 'boss-a1b2' }, 'hi')).toBe(
      '[Written by the agent in session "Boss" (id), not by the user. Reach it with SendMessage to "boss-a1b2".]\n\nhi'
    );
  });

  it('omits the address when the creator has none yet', () => {
    expect(attributeMessage({ id: 'id', name: 'Boss', agentName: null }, 'hi')).not.toContain(
      'SendMessage'
    );
  });
});
