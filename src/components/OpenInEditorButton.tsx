'use client';

import { Code } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { trpc } from '@/lib/trpc';
import { buildEditorFolderUrl } from '@/lib/editor-url';

interface OpenInEditorButtonProps {
  sessionId: string;
}

/**
 * Opens the session's worktree folder in a self-hosted code-server (browser
 * VS Code) instance in a new tab. Renders nothing when the editor is not
 * configured (CODE_SERVER_URL unset) or the session has no workspace on disk —
 * the server decides via sessions.getEditorInfo, so the UI stays dumb.
 */
export function OpenInEditorButton({ sessionId }: OpenInEditorButtonProps) {
  const { data } = trpc.sessions.getEditorInfo.useQuery({ sessionId });

  const url = data?.editor
    ? buildEditorFolderUrl(data.editor.baseUrl, data.editor.workspaceDir)
    : null;

  if (!url) {
    return null;
  }

  return (
    <Button
      variant="ghost"
      size="icon"
      asChild
      title="Open worktree in VS Code"
      className="shrink-0 h-8 w-8"
    >
      <a href={url} target="_blank" rel="noopener noreferrer">
        <Code className="h-4 w-4" />
      </a>
    </Button>
  );
}
