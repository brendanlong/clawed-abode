'use client';

import { useState, useCallback } from 'react';
import { getAuthToken } from '@/lib/auth-token';
import type { UploadedAttachment } from '@/lib/attachments';

interface UploadResponse {
  attachments: UploadedAttachment[];
}

/**
 * Uploads files to the session's upload directory via the `/api/upload` route.
 * Returns the saved attachments (name + stored name + absolute path) so the
 * caller can hold them as pending attachments until the next message is sent.
 */
export function useFileUpload(sessionId: string) {
  const [uploading, setUploading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const upload = useCallback(
    async (files: File[]): Promise<UploadedAttachment[]> => {
      if (files.length === 0) return [];

      setUploading(true);
      setError(null);
      try {
        const formData = new FormData();
        formData.append('sessionId', sessionId);
        for (const file of files) {
          formData.append('files', file);
        }

        const token = getAuthToken();
        const res = await fetch('/api/upload', {
          method: 'POST',
          headers: token ? { authorization: `Bearer ${token}` } : {},
          body: formData,
        });

        if (!res.ok) {
          const data = (await res.json().catch(() => null)) as { error?: string } | null;
          throw new Error(data?.error ?? `Upload failed (${res.status})`);
        }

        const data = (await res.json()) as UploadResponse;
        return data.attachments;
      } catch (err) {
        const message = err instanceof Error ? err.message : 'Upload failed';
        setError(message);
        throw err;
      } finally {
        setUploading(false);
      }
    },
    [sessionId]
  );

  return { upload, uploading, error, clearError: useCallback(() => setError(null), []) };
}
