import { File, FileText } from 'lucide-react';

/**
 * File icon used in tool displays: a plain document for reads, a document with
 * lines for writes.
 */
export function FileIcon({ variant = 'read' }: { variant?: 'read' | 'write' }) {
  const Icon = variant === 'write' ? FileText : File;
  return <Icon className="w-4 h-4 text-muted-foreground shrink-0" />;
}
