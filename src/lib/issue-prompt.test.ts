import { describe, it, expect } from 'vitest';
import { generateIssuePrompt } from './issue-prompt';
import type { Issue } from './types';

const issue: Issue = {
  id: 1,
  number: 42,
  title: 'Fix the bug',
  body: 'Something is broken',
  labels: [
    { name: 'bug', color: 'ff0000' },
    { name: 'ui', color: '00ff00' },
  ],
  comments: 0,
};

describe('generateIssuePrompt', () => {
  it('includes the issue number, title, URL, labels and body', () => {
    const prompt = generateIssuePrompt(issue, 'owner/repo');
    expect(prompt).toContain('## Issue #42: Fix the bug\n');
    expect(prompt).toContain('URL: https://github.com/owner/repo/issues/42\n');
    expect(prompt).toContain('Labels: bug, ui\n');
    expect(prompt).toContain('### Description\n\nSomething is broken');
  });

  it('asks the agent to commit and push', () => {
    const prompt = generateIssuePrompt(issue, 'owner/repo');
    expect(prompt.startsWith('Please fix the following GitHub issue and commit and push')).toBe(
      true
    );
    expect(prompt.endsWith('4. Push the changes to the remote repository')).toBe(true);
  });

  it('omits the labels line when the issue has none', () => {
    expect(generateIssuePrompt({ ...issue, labels: [] }, 'owner/repo')).not.toContain('Labels:');
  });

  it('says so when the issue has no description', () => {
    expect(generateIssuePrompt({ ...issue, body: null }, 'owner/repo')).toContain(
      '(No description provided)'
    );
    expect(generateIssuePrompt({ ...issue, body: '' }, 'owner/repo')).toContain(
      '(No description provided)'
    );
  });

  it('points at the comments only when there are some, with the right plural', () => {
    expect(generateIssuePrompt(issue, 'owner/repo')).not.toContain('gh issue view');
    expect(generateIssuePrompt({ ...issue, comments: 1 }, 'owner/repo')).toContain(
      'This issue has 1 comment which may contain useful context. Read them with `gh issue view 42 --repo owner/repo --comments`.'
    );
    expect(generateIssuePrompt({ ...issue, comments: 3 }, 'owner/repo')).toContain(
      'This issue has 3 comments which'
    );
  });
});
