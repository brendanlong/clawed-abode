import type { Repo } from '@/components/RepoSelector';
import type { Issue } from '@/lib/types';

export interface FormState {
  selectedRepo: Repo | null;
  selectedBranch: string;
  selectedIssue: Issue | null;
  sessionName: string;
  nameManuallyEdited: boolean;
}

export type FormAction =
  | { type: 'selectRepo'; repo: Repo }
  | { type: 'selectBranch'; branch: string }
  | { type: 'selectIssue'; issue: Issue | null }
  | { type: 'editName'; name: string };

export const initialFormState: FormState = {
  selectedRepo: null,
  selectedBranch: '',
  selectedIssue: null,
  sessionName: '',
  nameManuallyEdited: false,
};

export function formReducer(state: FormState, action: FormAction): FormState {
  switch (action.type) {
    case 'selectRepo':
      return {
        ...initialFormState,
        selectedRepo: action.repo,
      };
    case 'selectBranch':
      return { ...state, selectedBranch: action.branch };
    case 'selectIssue':
      return {
        ...state,
        selectedIssue: action.issue,
        sessionName: state.nameManuallyEdited
          ? state.sessionName
          : action.issue
            ? `#${action.issue.number}: ${action.issue.title}`
            : '',
      };
    case 'editName':
      return {
        ...state,
        sessionName: action.name,
        nameManuallyEdited: true,
      };
  }
}
