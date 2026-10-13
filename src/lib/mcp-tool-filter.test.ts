import { describe, it, expect } from 'vitest';
import {
  buildMcpToolFilter,
  mcpToolFilterSchema,
  isMcpToolBlocked,
  mcpToolDenyRules,
  mcpToolId,
  type FilteredMcpServer,
} from './mcp-tool-filter';

describe('mcpToolId', () => {
  it('normalizes server and tool names the way Claude Code does', () => {
    expect(mcpToolId('todoist', 'add-tasks')).toBe('mcp__todoist__add-tasks');
    expect(mcpToolId('my fx.v2', 'sp ace/x')).toBe('mcp__my_fx_v2__sp_ace_x');
  });
});

describe('isMcpToolBlocked', () => {
  const servers: FilteredMcpServer[] = [
    { name: 'todo', toolFilter: { allowed: ['find-tasks'], hidden: ['delete-object'] } },
    { name: 'open', toolFilter: null },
    { name: 'mail' },
  ];

  it('allows only the allowlisted tools of a filtered server', () => {
    expect(isMcpToolBlocked(servers, 'mcp__todo__find-tasks')).toBe(false);
    expect(isMcpToolBlocked(servers, 'mcp__todo__delete-object')).toBe(true);
  });

  it('blocks a tool the server added after the filter was saved', () => {
    expect(isMcpToolBlocked(servers, 'mcp__todo__brand-new-tool')).toBe(true);
  });

  it('leaves unfiltered servers and non-MCP tools alone', () => {
    expect(isMcpToolBlocked(servers, 'mcp__open__anything')).toBe(false);
    expect(isMcpToolBlocked(servers, 'mcp__mail__send')).toBe(false);
    expect(isMcpToolBlocked(servers, 'Bash')).toBe(false);
  });

  it('blocks when any copy of a server blocks, so the stricter filter wins', () => {
    const loosened: FilteredMcpServer[] = [{ name: 'todo', toolFilter: null }, ...servers];
    expect(isMcpToolBlocked(loosened, 'mcp__todo__delete-object')).toBe(true);
  });

  it('attributes a tool to the server with the longest matching name', () => {
    const nested: FilteredMcpServer[] = [
      { name: 'gh', toolFilter: { allowed: ['search'], hidden: [] } },
      { name: 'gh__ent' },
    ];
    expect(isMcpToolBlocked(nested, 'mcp__gh__ent__delete')).toBe(false);
    expect(isMcpToolBlocked(nested, 'mcp__gh__delete')).toBe(true);
  });

  it('blocks every tool of a server with an empty allowlist', () => {
    const none = [{ name: 'todo', toolFilter: { allowed: [], hidden: ['find'] } }];
    expect(isMcpToolBlocked(none, 'mcp__todo__find')).toBe(true);
  });

  it('matches allowlisted tools whose names need normalizing', () => {
    const odd = [{ name: 'my srv', toolFilter: { allowed: ['get.item'], hidden: [] } }];
    expect(isMcpToolBlocked(odd, 'mcp__my_srv__get_item')).toBe(false);
    expect(isMcpToolBlocked(odd, 'mcp__my_srv__put_item')).toBe(true);
  });
});

describe('mcpToolDenyRules', () => {
  it('lists every filtered server’s hidden tools, sorted', () => {
    expect(
      mcpToolDenyRules([
        { name: 'b', toolFilter: { allowed: [], hidden: ['z', 'y'] } },
        { name: 'a', toolFilter: { allowed: ['x'], hidden: ['w'] } },
        { name: 'c', toolFilter: null },
      ])
    ).toEqual(['mcp__a__w', 'mcp__b__y', 'mcp__b__z']);
  });
});

describe('mcpToolFilterSchema', () => {
  it('rejects a tool that is both allowed and hidden', () => {
    expect(mcpToolFilterSchema.safeParse({ allowed: ['a'], hidden: ['b'] }).success).toBe(true);
    expect(mcpToolFilterSchema.safeParse({ allowed: ['a'], hidden: ['a'] }).success).toBe(false);
  });
});

describe('buildMcpToolFilter', () => {
  it('splits the listed tools into allowed and hidden in server order', () => {
    const tools = [
      { name: 'find', readOnly: true },
      { name: 'add', readOnly: false },
      { name: 'get', readOnly: true },
    ];
    expect(buildMcpToolFilter(tools, new Set(['get', 'find', 'gone']))).toEqual({
      allowed: ['find', 'get'],
      hidden: ['add'],
    });
  });
});
