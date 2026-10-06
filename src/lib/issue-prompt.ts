import type { Issue } from '@/lib/types';

/** The initial prompt offered when a new session is started from a GitHub issue. */
export function generateIssuePrompt(issue: Issue, repoFullName: string): string {
  const issueUrl = `https://github.com/${repoFullName}/issues/${issue.number}`;
  const labels = issue.labels.map((l) => l.name).join(', ');

  let prompt = `Please fix the following GitHub issue and commit and push your changes:\n\n`;
  prompt += `## Issue #${issue.number}: ${issue.title}\n`;
  prompt += `URL: ${issueUrl}\n`;
  if (labels) {
    prompt += `Labels: ${labels}\n`;
  }
  prompt += `\n### Description\n\n`;
  prompt += issue.body || '(No description provided)';
  if (issue.comments > 0) {
    prompt += `\n\nThis issue has ${issue.comments} comment${issue.comments === 1 ? '' : 's'} which may contain useful context. Read them with \`gh issue view ${issue.number} --repo ${repoFullName} --comments\`.`;
  }
  prompt += `\n\n---\n\n`;
  prompt += `Please:\n`;
  prompt += `1. Analyze the issue and understand what needs to be fixed\n`;
  prompt += `2. Make the necessary code changes\n`;
  prompt += `3. Commit your changes with a descriptive message\n`;
  prompt += `4. Push the changes to the remote repository`;

  return prompt;
}
