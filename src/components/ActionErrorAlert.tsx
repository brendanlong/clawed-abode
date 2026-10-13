'use client';

import { X } from 'lucide-react';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';

export function ActionErrorAlert({
  error,
  onDismiss,
  className,
}: {
  error: string | null;
  onDismiss: () => void;
  className?: string;
}) {
  if (!error) return null;
  return (
    <Alert variant="destructive" className={cn('flex items-center gap-2 py-2', className)}>
      <AlertDescription className="flex-1">{error}</AlertDescription>
      <Button
        variant="ghost"
        size="icon"
        className="h-6 w-6 shrink-0"
        onClick={onDismiss}
        aria-label="Dismiss error"
      >
        <X className="h-4 w-4" />
      </Button>
    </Alert>
  );
}
