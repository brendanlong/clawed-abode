'use client';

import { Code } from 'lucide-react';
import { buildEditorFileUrl } from '@/lib/editor-url';
import { useMessageListContext } from './MessageListContext';

/**
 * Small "open this file in VS Code" link shown in the header of Read/Edit/Write
 * tool displays. Renders nothing when the editor is not configured (no editor
 * info in context) or the file path is not an absolute path we can open — the
 * server is authoritative (via sessions.getEditorInfo), so this stays dumb.
 *
 * Placed by ToolDisplayWrapper as a sibling of the collapsible trigger (not
 * inside it), so clicking the link opens the file rather than toggling the card.
 */
export function OpenInEditorFileLink({ filePath }: { filePath: string }) {
  const ctx = useMessageListContext();
  const editor = ctx?.editor ?? null;

  const url = editor ? buildEditorFileUrl(editor.baseUrl, editor.workspaceDir, filePath) : null;

  if (!url) {
    return null;
  }

  return (
    <a
      href={url}
      target="_blank"
      rel="noopener noreferrer"
      title="Open file in VS Code"
      className="text-muted-foreground hover:text-primary shrink-0 p-1"
      // Defensive: the link sits outside the collapsible trigger, but stop
      // propagation so a click never bubbles into a card toggle.
      onClick={(e) => e.stopPropagation()}
    >
      <Code className="h-4 w-4" />
    </a>
  );
}
