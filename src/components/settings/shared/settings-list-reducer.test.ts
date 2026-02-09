import { describe, it, expect } from 'vitest';
import { reduceSettingsListAction, initialSettingsListState } from './settings-list-reducer';
import type { SettingsListState, SettingsListAction } from './settings-list-reducer';

describe('reduceSettingsListAction', () => {
  describe('form visibility', () => {
    it('opens the form', () => {
      const result = reduceSettingsListAction(initialSettingsListState, { type: 'openForm' });
      expect(result).toEqual({ ...initialSettingsListState, showForm: true });
    });

    it('starts editing by id', () => {
      const result = reduceSettingsListAction(initialSettingsListState, {
        type: 'startEditing',
        id: 'item-1',
      });
      expect(result).toEqual({ ...initialSettingsListState, editingId: 'item-1' });
    });

    it('closes the form and clears editingId', () => {
      const state: SettingsListState = {
        ...initialSettingsListState,
        showForm: true,
        editingId: 'item-1',
      };
      const result = reduceSettingsListAction(state, { type: 'closeForm' });
      expect(result?.showForm).toBe(false);
      expect(result?.editingId).toBeNull();
    });

    it('formSuccess closes form and clears editingId', () => {
      const state: SettingsListState = {
        ...initialSettingsListState,
        showForm: true,
        editingId: 'item-1',
      };
      const result = reduceSettingsListAction(state, { type: 'formSuccess' });
      expect(result?.showForm).toBe(false);
      expect(result?.editingId).toBeNull();
    });
  });

  describe('delete flow', () => {
    it('sets delete target', () => {
      const result = reduceSettingsListAction(initialSettingsListState, {
        type: 'setDeleteTarget',
        name: 'MY_ITEM',
      });
      expect(result?.deleteTarget).toBe('MY_ITEM');
    });

    it('clears delete target', () => {
      const state: SettingsListState = {
        ...initialSettingsListState,
        deleteTarget: 'MY_ITEM',
      };
      const result = reduceSettingsListAction(state, { type: 'setDeleteTarget', name: null });
      expect(result?.deleteTarget).toBeNull();
    });

    it('starts deleting', () => {
      const result = reduceSettingsListAction(initialSettingsListState, { type: 'startDeleting' });
      expect(result?.isDeleting).toBe(true);
    });

    it('finishes deleting and clears target', () => {
      const state: SettingsListState = {
        ...initialSettingsListState,
        isDeleting: true,
        deleteTarget: 'MY_ITEM',
      };
      const result = reduceSettingsListAction(state, { type: 'finishDeleting' });
      expect(result?.isDeleting).toBe(false);
      expect(result?.deleteTarget).toBeNull();
    });
  });

  it('returns null for unrecognized actions', () => {
    const result = reduceSettingsListAction(initialSettingsListState, {
      type: 'unknownAction',
    } as unknown as SettingsListAction);
    expect(result).toBeNull();
  });

  it('preserves extra state fields from extended state', () => {
    interface ExtendedState extends SettingsListState {
      customField: string;
    }
    const state: ExtendedState = {
      ...initialSettingsListState,
      customField: 'preserved',
    };
    const result = reduceSettingsListAction(state, { type: 'openForm' });
    expect(result?.showForm).toBe(true);
    expect((result as ExtendedState).customField).toBe('preserved');
  });
});
