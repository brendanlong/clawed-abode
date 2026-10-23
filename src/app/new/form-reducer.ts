import type { Repo } from '@/components/RepoSelector';
import { SESSION_NAME_MAX_LENGTH, type Issue } from '@/lib/types';
import type { UploadedAttachment } from '@/lib/attachments';

export interface FormState {
  selectedRepo: Repo | null;
  /** The user's explicit pick, or '' for the repo's default (see `resolveBranch`). */
  selectedBranch: string;
  selectedIssue: Issue | null;
  sessionName: string;
  nameManuallyEdited: boolean;
  initialPrompt: string;
  promptManuallyEdited: boolean;
  /** Staged uploads to send with the initial prompt. */
  attachments: UploadedAttachment[];
  /** Per-session model override, or null to use the repo/global/env default. */
  claudeModel: string | null;
  sessionToolsEnabled: boolean;
}

export type FormAction =
  | { type: 'selectRepo'; repo: Repo }
  | { type: 'selectBranch'; branch: string }
  | { type: 'selectIssue'; issue: Issue | null; generatedPrompt?: string }
  | { type: 'editName'; name: string }
  | { type: 'editPrompt'; prompt: string }
  | { type: 'addAttachments'; attachments: UploadedAttachment[] }
  | { type: 'removeAttachment'; storedName: string }
  | { type: 'editModel'; claudeModel: string | null }
  | { type: 'setSessionTools'; enabled: boolean };

export const initialFormState: FormState = {
  selectedRepo: null,
  selectedBranch: '',
  selectedIssue: null,
  sessionName: '',
  nameManuallyEdited: false,
  initialPrompt: '',
  promptManuallyEdited: false,
  attachments: [],
  claudeModel: null,
  sessionToolsEnabled: false,
};

export function formReducer(state: FormState, action: FormAction): FormState {
  switch (action.type) {
    case 'selectRepo':
      return {
        ...initialFormState,
        selectedRepo: action.repo,
        attachments: state.attachments,
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
            ? `#${action.issue.number}: ${action.issue.title}`.slice(0, SESSION_NAME_MAX_LENGTH)
            : '',
        initialPrompt: state.promptManuallyEdited
          ? state.initialPrompt
          : (action.generatedPrompt ?? ''),
      };
    case 'editName':
      return {
        ...state,
        sessionName: action.name,
        nameManuallyEdited: true,
      };
    case 'editPrompt':
      return {
        ...state,
        initialPrompt: action.prompt,
        promptManuallyEdited: true,
      };
    case 'addAttachments':
      return { ...state, attachments: [...state.attachments, ...action.attachments] };
    case 'removeAttachment':
      return {
        ...state,
        attachments: state.attachments.filter((a) => a.storedName !== action.storedName),
      };
    case 'editModel':
      return { ...state, claudeModel: action.claudeModel };
    case 'setSessionTools':
      return { ...state, sessionToolsEnabled: action.enabled };
  }
}
