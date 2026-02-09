// -- Shared settings list state management --
// Base state and actions shared by EnvVarSection and McpServerSection

export interface SettingsListState {
  showForm: boolean;
  editingId: string | null;
  deleteTarget: string | null;
  isDeleting: boolean;
}

export type SettingsListAction =
  | { type: 'openForm' }
  | { type: 'startEditing'; id: string }
  | { type: 'closeForm' }
  | { type: 'formSuccess' }
  | { type: 'setDeleteTarget'; name: string | null }
  | { type: 'startDeleting' }
  | { type: 'finishDeleting' };

export const initialSettingsListState: SettingsListState = {
  showForm: false,
  editingId: null,
  deleteTarget: null,
  isDeleting: false,
};

/**
 * Handles the shared settings list actions. Returns the new state if the action
 * was handled, or null if the action is not a base settings list action.
 */
export function reduceSettingsListAction<S extends SettingsListState>(
  state: S,
  action: SettingsListAction
): S | null {
  switch (action.type) {
    case 'openForm':
      return { ...state, showForm: true };
    case 'startEditing':
      return { ...state, editingId: action.id };
    case 'closeForm':
      return { ...state, showForm: false, editingId: null };
    case 'formSuccess':
      return { ...state, showForm: false, editingId: null };
    case 'setDeleteTarget':
      return { ...state, deleteTarget: action.name };
    case 'startDeleting':
      return { ...state, isDeleting: true };
    case 'finishDeleting':
      return { ...state, isDeleting: false, deleteTarget: null };
    default:
      return null;
  }
}
