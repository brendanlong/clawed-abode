import { describe, it, expect } from 'vitest';
import { buildAgentName, buildAgentNameRequest, slugifyAgentName } from './agent-name';

const SESSION_ID = 'D37E7182-e925-4356-83d9-31135fe4b170';

describe('slugifyAgentName', () => {
  it('lowercases and hyphenates words', () => {
    expect(slugifyAgentName('Collatz Bound')).toBe('collatz-bound');
  });

  it('keeps at most three words', () => {
    expect(slugifyAgentName('prove the collatz bound today')).toBe('prove-the-collatz');
  });

  it('strips punctuation and surrounding text noise', () => {
    expect(slugifyAgentName('  "Peer_Messages!"\n')).toBe('peer-messages');
  });

  it('caps the length without leaving a trailing hyphen', () => {
    const slug = slugifyAgentName('abcdefghijklmnopqrstuvwxyz abcdefghijklmnop');
    expect(slug).toBe('abcdefghijklmnopqrstuvwxyz-abcde');
    expect(slugifyAgentName('abcdefghijklmnopqrstuvwxyzabcdef ghi')).toBe(
      'abcdefghijklmnopqrstuvwxyzabcdef'
    );
  });

  it('returns null when nothing usable remains', () => {
    expect(slugifyAgentName('')).toBeNull();
    expect(slugifyAgentName('  !!! ')).toBeNull();
  });
});

describe('buildAgentName', () => {
  it('suffixes the generated base with the start of the session id', () => {
    expect(buildAgentName('collatz-bound', SESSION_ID, 'clawed-abode')).toBe('collatz-bound-d37e');
  });

  it('falls back to the whole repo name when there is no base', () => {
    expect(buildAgentName(null, SESSION_ID, 'my_big.repo-name')).toBe('my-big-repo-name-d37e');
  });

  it('falls back to a bare session id prefix with no base and no repo', () => {
    expect(buildAgentName(null, SESSION_ID, null)).toBe('d37e7182');
  });
});

describe('buildAgentNameRequest', () => {
  it('includes the title, repo, and prompt', () => {
    expect(
      buildAgentNameRequest({ title: 'Fix it', repoName: 'clawed-abode', initialPrompt: ' Do X ' })
    ).toBe('Session title: Fix it\nRepository: clawed-abode\n\nFirst prompt:\nDo X');
  });

  it('omits a blank prompt and marks a missing repo', () => {
    expect(buildAgentNameRequest({ title: 'Notes', repoName: null, initialPrompt: '  ' })).toBe(
      'Session title: Notes\nRepository: (none)'
    );
  });

  it('truncates long prompts', () => {
    const request = buildAgentNameRequest({
      title: 't',
      repoName: null,
      initialPrompt: 'x'.repeat(5000),
    });
    expect(request.length).toBeLessThan(2100);
  });
});
