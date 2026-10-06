import { describe, it, expect } from 'vitest';
import {
  buildCreateSessionInput,
  formDefaultSessionName,
  resolveBranch,
} from './create-session-input';
import { initialFormState, type FormState } from './form-reducer';
import type { Repo } from '@/components/RepoSelector';
import { NO_REPO_SENTINEL } from '@/lib/repo-full-name';

const repo: Repo = {
  id: 1,
  fullName: 'owner/repo',
  name: 'repo',
  owner: 'owner',
  description: null,
  private: false,
  defaultBranch: 'main',
};

const noRepo: Repo = { ...repo, id: 0, fullName: NO_REPO_SENTINEL, name: 'No Repository' };

const withRepo = (selectedRepo: Repo, fields: Partial<FormState> = {}): FormState => ({
  ...initialFormState,
  selectedRepo,
  ...fields,
});

describe('resolveBranch', () => {
  const branchList = { branches: ['main', 'dev'], defaultBranch: 'main' };

  it("prefers the user's pick", () => {
    expect(resolveBranch('dev', branchList)).toBe('dev');
  });

  it('falls back to the default branch once branches load', () => {
    expect(resolveBranch('', branchList)).toBe('main');
  });

  it('has no branch while branches are loading', () => {
    expect(resolveBranch('', undefined)).toBe('');
  });

  it('has no branch for an empty repo, even though it names a default', () => {
    expect(resolveBranch('', { branches: [], defaultBranch: 'main' })).toBe('');
  });
});

describe('formDefaultSessionName', () => {
  it('names a repo session after the repo and branch, and a no-repo session "Workspace"', () => {
    expect(formDefaultSessionName(repo, 'dev')).toBe('repo - dev');
    expect(formDefaultSessionName(noRepo, '')).toBe('Workspace');
  });
});

describe('buildCreateSessionInput', () => {
  it('cannot submit before a repository is chosen', () => {
    expect(buildCreateSessionInput(initialFormState, 'main')).toBeNull();
  });

  it('cannot submit a repo session without a branch', () => {
    expect(buildCreateSessionInput(withRepo(repo), '')).toBeNull();
  });

  it('builds a repo session with the resolved branch and a default name', () => {
    expect(buildCreateSessionInput(withRepo(repo), 'main')).toEqual({
      name: 'repo - main',
      repoFullName: 'owner/repo',
      branch: 'main',
      initialPrompt: undefined,
      claudeModel: undefined,
    });
  });

  it('submits the default branch when the user never picked one', () => {
    const branch = resolveBranch('', { branches: ['dev', 'main'], defaultBranch: 'main' });
    expect(buildCreateSessionInput(withRepo(repo), branch)).toMatchObject({ branch: 'main' });
  });

  it('builds a no-repo session without a repo or branch', () => {
    expect(buildCreateSessionInput(withRepo(noRepo), '')).toEqual({
      name: 'Workspace',
      repoFullName: undefined,
      branch: undefined,
      initialPrompt: undefined,
      claudeModel: undefined,
    });
  });

  it('keeps a typed name and trims the prompt and model, dropping blanks', () => {
    const form = withRepo(repo, {
      sessionName: 'My session',
      initialPrompt: '  do it  ',
      claudeModel: '  opus  ',
    });
    expect(buildCreateSessionInput(form, 'dev')).toEqual({
      name: 'My session',
      repoFullName: 'owner/repo',
      branch: 'dev',
      initialPrompt: 'do it',
      claudeModel: 'opus',
    });

    const blank = withRepo(repo, { initialPrompt: '   ', claudeModel: '  ' });
    expect(buildCreateSessionInput(blank, 'dev')).toMatchObject({
      initialPrompt: undefined,
      claudeModel: undefined,
    });
  });
});
