import { describe, it, expect } from 'vitest';
import { extractRepoFullName } from './utils';

describe('extractRepoFullName', () => {
  it('should extract owner/repo from GitHub URL', () => {
    expect(extractRepoFullName('https://github.com/owner/repo')).toBe('owner/repo');
  });

  it('should remove .git suffix', () => {
    expect(extractRepoFullName('https://github.com/owner/repo.git')).toBe('owner/repo');
  });

  it('should handle repos with dots in the name', () => {
    expect(extractRepoFullName('https://github.com/owner/my.repo.name')).toBe('owner/my.repo.name');
  });

  it('should handle repos with dashes and underscores', () => {
    expect(extractRepoFullName('https://github.com/my-org/my_repo-name')).toBe(
      'my-org/my_repo-name'
    );
  });
});
