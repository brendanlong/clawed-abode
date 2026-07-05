'use client';

import { useEffect, useRef, useState } from 'react';
import { Input } from '@/components/ui/input';
import { SESSION_NAME_MAX_LENGTH } from '@/lib/types';
import { cn } from '@/lib/utils';

interface EditableSessionNameProps {
  name: string;
  onRename: (name: string) => void;
  /** Whether editing is allowed (e.g. disabled for archived sessions). */
  disabled?: boolean;
  className?: string;
}

/**
 * Displays a session name that can be renamed inline: click the title to edit,
 * Enter to save, Escape to cancel. Renaming never touches the session id.
 */
export function EditableSessionName({
  name,
  onRename,
  disabled = false,
  className,
}: EditableSessionNameProps) {
  const [isEditing, setIsEditing] = useState(false);
  const [value, setValue] = useState(name);
  const inputRef = useRef<HTMLInputElement>(null);

  // `value` is the edit draft, seeded from `name` each time editing begins
  // (see startEditing), so it needs no effect to stay in sync with the prop.
  useEffect(() => {
    if (isEditing) {
      inputRef.current?.select();
    }
  }, [isEditing]);

  const startEditing = () => {
    if (disabled) return;
    setValue(name);
    setIsEditing(true);
  };

  const commit = () => {
    setIsEditing(false);
    const trimmed = value.trim();
    if (trimmed && trimmed !== name) {
      onRename(trimmed);
    }
  };

  const cancel = () => {
    setValue(name);
    setIsEditing(false);
  };

  if (isEditing) {
    return (
      <Input
        ref={inputRef}
        value={value}
        onChange={(e) => setValue(e.target.value)}
        onBlur={commit}
        onKeyDown={(e) => {
          if (e.key === 'Enter') {
            e.preventDefault();
            commit();
          } else if (e.key === 'Escape') {
            e.preventDefault();
            cancel();
          }
        }}
        maxLength={SESSION_NAME_MAX_LENGTH}
        aria-label="Session name"
        className={cn('h-auto py-0.5 font-semibold', className)}
      />
    );
  }

  return (
    <h1
      className={cn(
        'font-semibold break-words',
        !disabled && 'cursor-text rounded hover:bg-muted/50',
        className
      )}
      onClick={startEditing}
      title={disabled ? undefined : 'Click to rename'}
    >
      {name}
    </h1>
  );
}
