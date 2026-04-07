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
      });
    });

    it('resets to initial state except for the new repo', () => {
      const result = formReducer(initialFormState, { type: 'selectRepo', repo: mockRepo });

      expect(result.selectedRepo).toBe(mockRepo);
      expect(result.selectedBranch).toBe('');
      expect(result.selectedIssue).toBeNull();
      expect(result.sessionName).toBe('');
      expect(result.nameManuallyEdited).toBe(false);
      expect(result.initialPrompt).toBe('');
      expect(result.promptManuallyEdited).toBe(false);
    });
  });

  describe('selectBranch', () => {
    it('sets the selected branch', () => {
      const state: FormState = {
        ...initialFormState,
        selectedRepo: mockRepo,
      };

      const result = formReducer(state, { type: 'selectBranch', branch: 'feature-branch' });

      expect(result.selectedBranch).toBe('feature-branch');
      expect(result.selectedRepo).toBe(mockRepo);
    });

    it('preserves other state when changing branch', () => {
      const state: FormState = {
        selectedRepo: mockRepo,
        selectedBranch: 'main',
        selectedIssue: mockIssue,
        sessionName: 'my session',
        nameManuallyEdited: true,
        initialPrompt: 'my prompt',
        promptManuallyEdited: true,
      };

      const result = formReducer(state, { type: 'selectBranch', branch: 'develop' });

      expect(result.selectedBranch).toBe('develop');
      expect(result.selectedIssue).toBe(mockIssue);
      expect(result.sessionName).toBe('my session');
      expect(result.nameManuallyEdited).toBe(true);
      expect(result.initialPrompt).toBe('my prompt');
      expect(result.promptManuallyEdited).toBe(true);
    });
  });

  describe('selectIssue', () => {
    it('sets the issue and auto-fills session name when name was not manually edited', () => {
      const state: FormState = {
        ...initialFormState,
        selectedRepo: mockRepo,
        selectedBranch: 'main',
      };

      const result = formReducer(state, { type: 'selectIssue', issue: mockIssue });

      expect(result.selectedIssue).toBe(mockIssue);
      expect(result.sessionName).toBe('#42: Fix the bug');
    });

    it('sets the generated prompt when prompt was not manually edited', () => {
      const state: FormState = {
        ...initialFormState,
        selectedRepo: mockRepo,
        selectedBranch: 'main',
      };

      const result = formReducer(state, {
        type: 'selectIssue',
        issue: mockIssue,
        generatedPrompt: 'Fix issue #42',
      });

      expect(result.initialPrompt).toBe('Fix issue #42');
    });

    it('does not overwrite session name when name was manually edited', () => {
      const state: FormState = {
        ...initialFormState,
        selectedRepo: mockRepo,
        selectedBranch: 'main',
        sessionName: 'My custom name',
        nameManuallyEdited: true,
      };

      const result = formReducer(state, { type: 'selectIssue', issue: mockIssue });

      expect(result.selectedIssue).toBe(mockIssue);
      expect(result.sessionName).toBe('My custom name');
    });

    it('does not overwrite prompt when prompt was manually edited', () => {
      const state: FormState = {
        ...initialFormState,
        selectedRepo: mockRepo,
        selectedBranch: 'main',
        initialPrompt: 'My custom prompt',
        promptManuallyEdited: true,
      };

      const result = formReducer(state, {
        type: 'selectIssue',
        issue: mockIssue,
        generatedPrompt: 'Fix issue #42',
      });

      expect(result.initialPrompt).toBe('My custom prompt');
    });

    it('clears session name when issue is deselected and name was not manually edited', () => {
      const state: FormState = {
        ...initialFormState,
        selectedRepo: mockRepo,
        selectedBranch: 'main',
        selectedIssue: mockIssue,
        sessionName: '#42: Fix the bug',
      };

      const result = formReducer(state, { type: 'selectIssue', issue: null });

      expect(result.selectedIssue).toBeNull();
      expect(result.sessionName).toBe('');
    });

    it('clears prompt when issue is deselected and prompt was not manually edited', () => {
      const state: FormState = {
        ...initialFormState,
        selectedRepo: mockRepo,
        selectedBranch: 'main',
        selectedIssue: mockIssue,
        initialPrompt: 'Fix issue #42',
      };

      const result = formReducer(state, { type: 'selectIssue', issue: null });

      expect(result.selectedIssue).toBeNull();
      expect(result.initialPrompt).toBe('');
    });

    it('truncates session name to max length when issue title is very long', () => {
      const longTitle = 'A'.repeat(200);
      const longIssue: Issue = {
        ...mockIssue,
        number: 1,
        title: longTitle,
      };
      const state: FormState = {
        ...initialFormState,
        selectedRepo: mockRepo,
        selectedBranch: 'main',
      };

      const result = formReducer(state, { type: 'selectIssue', issue: longIssue });

      expect(result.sessionName.length).toBe(SESSION_NAME_MAX_LENGTH);
      expect(result.sessionName).toBe(`#1: ${longTitle}`.slice(0, SESSION_NAME_MAX_LENGTH));
    });

    it('preserves session name when issue is deselected and name was manually edited', () => {
      const state: FormState = {
        ...initialFormState,
        selectedRepo: mockRepo,
        selectedBranch: 'main',
        selectedIssue: mockIssue,
        sessionName: 'My custom name',
        nameManuallyEdited: true,
      };

      const result = formReducer(state, { type: 'selectIssue', issue: null });

      expect(result.selectedIssue).toBeNull();
      expect(result.sessionName).toBe('My custom name');
    });

    it('preserves prompt when issue is deselected and prompt was manually edited', () => {
      const state: FormState = {
        ...initialFormState,
        selectedRepo: mockRepo,
        selectedBranch: 'main',
        selectedIssue: mockIssue,
        initialPrompt: 'My custom prompt',
        promptManuallyEdited: true,
      };

      const result = formReducer(state, { type: 'selectIssue', issue: null });

      expect(result.selectedIssue).toBeNull();
      expect(result.initialPrompt).toBe('My custom prompt');
    });
  });

  describe('editName', () => {
    it('sets the session name and marks it as manually edited', () => {
      const state: FormState = {
        ...initialFormState,
        selectedRepo: mockRepo,
        selectedBranch: 'main',
      };

      const result = formReducer(state, { type: 'editName', name: 'Custom session' });

      expect(result.sessionName).toBe('Custom session');
      expect(result.nameManuallyEdited).toBe(true);
    });

    it('marks as manually edited even when setting to empty string', () => {
      const state: FormState = {
        ...initialFormState,
        selectedRepo: mockRepo,
        sessionName: 'Something',
        nameManuallyEdited: false,
      };

      const result = formReducer(state, { type: 'editName', name: '' });

      expect(result.sessionName).toBe('');
      expect(result.nameManuallyEdited).toBe(true);
    });
  });

  describe('editPrompt', () => {
    it('sets the prompt and marks it as manually edited', () => {
      const state: FormState = {
        ...initialFormState,
        selectedRepo: mockRepo,
        selectedBranch: 'main',
      };

      const result = formReducer(state, { type: 'editPrompt', prompt: 'Custom prompt' });

      expect(result.initialPrompt).toBe('Custom prompt');
      expect(result.promptManuallyEdited).toBe(true);
    });

    it('marks as manually edited even when setting to empty string', () => {
      const state: FormState = {
        ...initialFormState,
        selectedRepo: mockRepo,
        initialPrompt: 'Something',
        promptManuallyEdited: false,
      };

      const result = formReducer(state, { type: 'editPrompt', prompt: '' });

      expect(result.initialPrompt).toBe('');
      expect(result.promptManuallyEdited).toBe(true);
    });
  });

  describe('state transitions', () => {
    it('handles full workflow: select repo -> branch -> issue -> edit name -> change issue', () => {
      let state = initialFormState;

      // Select repo
      state = formReducer(state, { type: 'selectRepo', repo: mockRepo });
      expect(state.selectedRepo).toBe(mockRepo);

      // Select branch
      state = formReducer(state, { type: 'selectBranch', branch: 'main' });
      expect(state.selectedBranch).toBe('main');

      // Select issue - auto-fills name and prompt
      state = formReducer(state, {
        type: 'selectIssue',
        issue: mockIssue,
        generatedPrompt: 'Fix issue #42',
      });
      expect(state.sessionName).toBe('#42: Fix the bug');
      expect(state.initialPrompt).toBe('Fix issue #42');

      // Manually edit name
      state = formReducer(state, { type: 'editName', name: 'My preferred name' });
      expect(state.nameManuallyEdited).toBe(true);

      // Manually edit prompt
      state = formReducer(state, { type: 'editPrompt', prompt: 'My custom prompt' });
      expect(state.promptManuallyEdited).toBe(true);

      // Select a different issue - should NOT overwrite manual name or prompt
      const anotherIssue: Issue = {
        ...mockIssue,
        number: 99,
        title: 'Another issue',
      };
      state = formReducer(state, {
        type: 'selectIssue',
        issue: anotherIssue,
        generatedPrompt: 'Fix issue #99',
      });
      expect(state.sessionName).toBe('My preferred name');
      expect(state.initialPrompt).toBe('My custom prompt');
      expect(state.selectedIssue).toBe(anotherIssue);
    });

    it('resets nameManuallyEdited and promptManuallyEdited when selecting a new repo', () => {
      let state: FormState = {
        ...initialFormState,
        selectedRepo: mockRepo,
        selectedBranch: 'main',
        sessionName: 'Custom name',
        nameManuallyEdited: true,
        initialPrompt: 'Custom prompt',
        promptManuallyEdited: true,
      };

      // Select new repo - should reset everything
      state = formReducer(state, { type: 'selectRepo', repo: mockRepo2 });
      expect(state.nameManuallyEdited).toBe(false);
      expect(state.promptManuallyEdited).toBe(false);
      expect(state.initialPrompt).toBe('');

      // Now selecting an issue should auto-fill name and prompt
      state = formReducer(state, {
        type: 'selectIssue',
        issue: mockIssue,
        generatedPrompt: 'Fix issue #42',
      });
      expect(state.sessionName).toBe('#42: Fix the bug');
      expect(state.initialPrompt).toBe('Fix issue #42');
    });
  });
});
