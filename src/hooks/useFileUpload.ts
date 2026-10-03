'use client';

import { useState, useCallback } from 'react';
import { getAuthToken } from '@/lib/auth-token';
import type { UploadedAttachment } from '@/lib/attachments';

interface UploadResponse {
  attachment: UploadedAttachment;
}

async function uploadFile(sessionId: string, file: File): Promise<UploadedAttachment> {
  const params = new URLSearchParams({ sessionId, name: file.name });
  const token = getAuthToken();
  const res = await fetch(`/api/upload?${params}`, {
    method: 'POST',
    headers: token ? { authorization: `Bearer ${token}` } : {},
    body: file,
  });

  if (!res.ok) {
    const data = (await res.json().catch(() => null)) as { error?: string } | null;
    throw new Error(data?.error ?? `Upload failed (${res.status})`);
  }

  const data = (await res.json()) as UploadResponse;
  return data.attachment;
}

/**
 * Uploads files (one request each, in parallel) to the session's upload directory
 * via the `/api/upload` route.
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
        return await Promise.all(files.map((file) => uploadFile(sessionId, file)));
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
