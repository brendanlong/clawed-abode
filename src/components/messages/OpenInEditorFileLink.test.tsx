import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { OpenInEditorFileLink } from './OpenInEditorFileLink';
import { MessageListProvider } from './MessageListContext';
import type { EditorInfo } from '@/lib/editor-url';

function renderWithEditor(filePath: string, editor: EditorInfo | null) {
  return render(
    <MessageListProvider
      value={{
        latestTodoWriteId: null,
        manuallyToggledTodoIds: new Set(),
        onTodoManualToggle: () => {},
        planContentByToolUseId: new Map(),
        renderSubagentTranscript: () => null,
        editor,
      }}
    >
      <OpenInEditorFileLink filePath={filePath} />
    </MessageListProvider>
  );
}

describe('OpenInEditorFileLink', () => {
  const editor: EditorInfo = { baseUrl: 'https://host', workspaceDir: '/ws/repo' };

  it('renders nothing when the editor is not configured', () => {
    const { container } = renderWithEditor('/ws/repo/src/a.ts', null);
    expect(container).toBeEmptyDOMElement();
  });

  it('renders nothing for a non-absolute file path', () => {
    const { container } = renderWithEditor('Unknown file', editor);
    expect(container).toBeEmptyDOMElement();
  });

  it('renders a link to the file when configured', () => {
    renderWithEditor('/ws/repo/src/a.ts', editor);
    const link = screen.getByRole('link', { name: /open file in vs code/i });
    expect(link).toHaveAttribute('target', '_blank');
    expect(link.getAttribute('href')).toBe(
      'https://host/?folder=%2Fws%2Frepo&payload=' +
        encodeURIComponent('[["openFile","vscode-remote://remote/ws/repo/src/a.ts"]]')
    );
  });
});
