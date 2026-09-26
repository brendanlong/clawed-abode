import { describe, it, expect } from 'vitest';
import { formReducer, initialFormState } from './form-reducer';
import { SESSION_NAME_MAX_LENGTH } from '@/lib/types';
import type { FormState } from './form-reducer';
import type { Repo } from '@/components/RepoSelector';
import type { Issue } from '@/lib/types';

const mockRepo: Repo = {
  id: 1,
  fullName: 'owner/repo',
  name: 'repo',
  owner: 'owner',
  description: 'A test repo',
  private: false,
  defaultBranch: 'main',
};

const mockRepo2: Repo = {
  id: 2,
  fullName: 'owner/other-repo',
  name: 'other-repo',
  owner: 'owner',
  description: null,
  private: true,
  defaultBranch: 'main',
};

const mockIssue: Issue = {
  id: 100,
  number: 42,
  title: 'Fix the bug',
  body: 'Something is broken',
  state: 'open',
  author: 'testuser',
  labels: [{ name: 'bug', color: 'ff0000' }],
  comments: 0,
  createdAt: '2024-01-01T00:00:00Z',
  updatedAt: '2024-01-01T00:00:00Z',
};

describe('formReducer', () => {
  describe('selectRepo', () => {
    it('sets the selected repo and resets all other state', () => {
      const state: FormState = {
        selectedRepo: mockRepo,
        selectedBranch: 'main',
        selectedIssue: mockIssue,
        sessionName: 'some name',
        nameManuallyEdited: true,
        initialPrompt: 'some prompt',
        promptManuallyEdited: true,
        claudeModel: 'sonnet',
      };

      const result = formReducer(state, { type: 'selectRepo', repo: mockRepo2 });

      expect(result).toEqual({
        selectedRepo: mockRepo2,
        selectedBranch: '',
        selectedIssue: null,
        sessionName: '',
        nameManuallyEdited: false,
        initialPrompt: '',
        promptManuallyEdited: false,
        claudeModel: null,
      });
    });
  });

  describe('selectBranch', () => {
    it('sets the branch and preserves other state', () => {
      const state: FormState = {
        selectedRepo: mockRepo,
        selectedBranch: 'main',
        selectedIssue: mockIssue,
        sessionName: 'my session',
        nameManuallyEdited: true,
        initialPrompt: 'my prompt',
        promptManuallyEdited: true,
        claudeModel: null,
      };

      const result = formReducer(state, { type: 'selectBranch', branch: 'develop' });

      expect(result).toEqual({ ...state, selectedBranch: 'develop' });
    });
  });

  describe('selectIssue', () => {
    const base: FormState = { ...initialFormState, selectedRepo: mockRepo, selectedBranch: 'main' };
    const edited: FormState = {
      ...base,
      sessionName: 'My custom name',
      nameManuallyEdited: true,
      initialPrompt: 'My custom prompt',
      promptManuallyEdited: true,
    };

    it('auto-fills name and prompt from the issue unless they were manually edited', () => {
      const select = {
        type: 'selectIssue',
        issue: mockIssue,
        generatedPrompt: 'Fix issue #42',
      } as const;

      expect(formReducer(base, select)).toMatchObject({
        selectedIssue: mockIssue,
        sessionName: '#42: Fix the bug',
        initialPrompt: 'Fix issue #42',
      });
      expect(formReducer(edited, select)).toMatchObject({
        selectedIssue: mockIssue,
        sessionName: 'My custom name',
        initialPrompt: 'My custom prompt',
      });
    });

    it('clears auto-filled name and prompt on deselect but preserves manual edits', () => {
      const autoFilled: FormState = {
        ...base,
        selectedIssue: mockIssue,
        sessionName: '#42: Fix the bug',
        initialPrompt: 'Fix issue #42',
      };
      const deselect = { type: 'selectIssue', issue: null } as const;

      expect(formReducer(autoFilled, deselect)).toMatchObject({
        selectedIssue: null,
        sessionName: '',
        initialPrompt: '',
      });
      expect(formReducer({ ...edited, selectedIssue: mockIssue }, deselect)).toMatchObject({
        selectedIssue: null,
        sessionName: 'My custom name',
        initialPrompt: 'My custom prompt',
      });
    });

    it('truncates session name to max length when issue title is very long', () => {
      const longTitle = 'A'.repeat(200);
      const longIssue: Issue = { ...mockIssue, number: 1, title: longTitle };

      const result = formReducer(base, { type: 'selectIssue', issue: longIssue });

      expect(result.sessionName.length).toBe(SESSION_NAME_MAX_LENGTH);
      expect(result.sessionName).toBe(`#1: ${longTitle}`.slice(0, SESSION_NAME_MAX_LENGTH));
    });
  });

  it.each(['Custom', ''])(
    'editName / editPrompt set %j and mark the field manually edited',
    (value) => {
      const state: FormState = { ...initialFormState, sessionName: 'Old', initialPrompt: 'Old' };

      expect(formReducer(state, { type: 'editName', name: value })).toMatchObject({
        sessionName: value,
        nameManuallyEdited: true,
      });
      expect(formReducer(state, { type: 'editPrompt', prompt: value })).toMatchObject({
        initialPrompt: value,
        promptManuallyEdited: true,
      });
    }
  );

  it('editModel sets the per-session model override', () => {
    const result = formReducer(initialFormState, { type: 'editModel', claudeModel: 'sonnet' });
    expect(result.claudeModel).toBe('sonnet');
  });
});
