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
 * via the `/api/upload` route. Resolves with the attachments that saved, so the
 * caller can hold them as pending attachments until the next message is sent;
 * any per-file failures are reported through `error` rather than discarding the
 * files that did upload.
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
        const results = await Promise.allSettled(files.map((file) => uploadFile(sessionId, file)));
        const failures = results.flatMap((result, i) =>
          result.status === 'rejected'
            ? [
                `${files[i].name}: ${result.reason instanceof Error ? result.reason.message : 'Upload failed'}`,
              ]
            : []
        );
        if (failures.length > 0) setError(failures.join('; '));
        return results.flatMap((result) => (result.status === 'fulfilled' ? [result.value] : []));
      } finally {
        setUploading(false);
      }
    },
    [sessionId]
  );

  return { upload, uploading, error, clearError: useCallback(() => setError(null), []) };
}
