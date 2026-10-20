'use client';

import { useState, useCallback, useEffect, useRef } from 'react';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';
import { writeClipboardText } from '@/lib/clipboard';

type CopyState = 'idle' | 'copied' | 'failed';

const LABELS: Record<CopyState, string> = {
  idle: 'Copy',
  copied: 'Copied!',
  failed: 'Copy failed',
};

/**
 * Copy button that briefly shows whether the copy worked. `getText` may return
 * a promise when part of the text has to be fetched first; if that fetch (or
 * the clipboard write) fails, nothing is copied and the button says so.
 */
export function CopyButton({ getText }: { getText: () => string | Promise<string> }) {
  const [state, setState] = useState<CopyState>('idle');
  // MessageList unmounts rows freely (relocated subagent boxes), so the reset
  // timer has to be cancelled or it fires setState on an unmounted component.
  const resetTimer = useRef<ReturnType<typeof setTimeout>>(undefined);

  useEffect(() => () => clearTimeout(resetTimer.current), []);

  const show = useCallback((next: CopyState) => {
    setState(next);
    clearTimeout(resetTimer.current);
    resetTimer.current = setTimeout(() => setState('idle'), 2000);
  }, []);

  const handleCopy = useCallback(async () => {
    try {
      await writeClipboardText(getText());
      show('copied');
    } catch (err) {
      console.error('Failed to copy:', err);
      show('failed');
    }
  }, [getText, show]);

  return (
    <Button
      variant="ghost"
      size="sm"
      onClick={handleCopy}
      className={cn('h-6 px-2 text-xs', state === 'failed' && 'text-destructive')}
    >
      {LABELS[state]}
    </Button>
  );
}
