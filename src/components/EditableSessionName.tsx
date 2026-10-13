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
 * Displays a session name that can be renamed inline: activate the title to
 * edit, Enter to save, Escape to cancel. Renaming never touches the session id.
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
  const buttonRef = useRef<HTMLButtonElement>(null);
  // Set when editing ends by keyboard, so focus returns to the title instead of
  // the page body; a blur-commit leaves focus wherever the user moved it.
  const refocusRef = useRef(false);

  // `value` is the edit draft, seeded from `name` each time editing begins
  // (see startEditing), so it needs no effect to stay in sync with the prop.
  useEffect(() => {
    if (isEditing) {
      inputRef.current?.focus();
      inputRef.current?.select();
    } else if (refocusRef.current) {
      refocusRef.current = false;
      buttonRef.current?.focus();
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
            refocusRef.current = true;
            commit();
          } else if (e.key === 'Escape') {
            e.preventDefault();
            refocusRef.current = true;
            cancel();
          }
        }}
        maxLength={SESSION_NAME_MAX_LENGTH}
        aria-label="Session name"
        className={cn('h-auto py-0.5 font-semibold', className)}
      />
    );
  }

  if (disabled) {
    return (
      <h1 className={cn('font-semibold truncate', className)} title={name}>
        {name}
      </h1>
    );
  }

  // The button lives inside the heading so the page keeps its heading while
  // renaming stays reachable by keyboard.
  return (
    <h1 className={cn('font-semibold truncate', className)}>
      <button
        ref={buttonRef}
        type="button"
        onClick={startEditing}
        title={`${name} — click to rename`}
        className="max-w-full truncate text-left cursor-text rounded hover:bg-muted/50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
      >
        {name}
      </button>
    </h1>
  );
}
