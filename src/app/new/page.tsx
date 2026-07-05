'use client';

import { useState, useCallback, useReducer, useRef } from 'react';
import { useRouter } from 'next/navigation';
import Link from 'next/link';
import { Paperclip } from 'lucide-react';
import { AuthGuard } from '@/components/AuthGuard';
import { Header } from '@/components/Header';
import { trpc } from '@/lib/trpc';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { Label } from '@/components/ui/label';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Spinner } from '@/components/ui/spinner';
import { RepoSelector, NO_REPO_SENTINEL } from '@/components/RepoSelector';
import { BranchSelector } from '@/components/BranchSelector';
import { IssueSelector } from '@/components/IssueSelector';
import { AttachmentChip } from '@/components/AttachmentChip';
import { useFileUpload } from '@/hooks/useFileUpload';
import type { Repo } from '@/components/RepoSelector';
import type { Issue } from '@/lib/types';
import { SESSION_NAME_MAX_LENGTH } from '@/lib/types';
import { MAX_ATTACHMENTS } from '@/lib/attachments';
import { formReducer, initialFormState } from './form-reducer';

function generateIssuePrompt(issue: Issue, repoFullName: string): string {
  const issueUrl = `https://github.com/${repoFullName}/issues/${issue.number}`;
  const labels = issue.labels.map((l) => l.name).join(', ');

  let prompt = `Please fix the following GitHub issue and commit and push your changes:\n\n`;
  prompt += `## Issue #${issue.number}: ${issue.title}\n`;
  prompt += `URL: ${issueUrl}\n`;
  if (labels) {
    prompt += `Labels: ${labels}\n`;
  }
  prompt += `\n### Description\n\n`;
  prompt += issue.body || '(No description provided)';
  if (issue.comments > 0) {
    prompt += `\n\nThis issue has ${issue.comments} comment${issue.comments === 1 ? '' : 's'} which may contain useful context. Read them with \`gh issue view ${issue.number} --repo ${repoFullName} --comments\`.`;
  }
  prompt += `\n\n---\n\n`;
  prompt += `Please:\n`;
  prompt += `1. Analyze the issue and understand what needs to be fixed\n`;
  prompt += `2. Make the necessary code changes\n`;
  prompt += `3. Commit your changes with a descriptive message\n`;
  prompt += `4. Push the changes to the remote repository`;

  return prompt;
}

function NewSessionForm() {
  const router = useRouter();
  const [form, dispatch] = useReducer(formReducer, initialFormState);
  const [error, setError] = useState('');
  // Files chosen for the initial prompt. Held raw (not uploaded) until submit,
  // since there is no session workspace to upload to until the session exists.
  const [files, setFiles] = useState<File[]>([]);
  // Covers the whole create → upload → register sequence (createMutation.isPending
  // only spans the create call).
  const [submitting, setSubmitting] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const isNoRepo = form.selectedRepo?.fullName === NO_REPO_SENTINEL;
  const hasRepo = form.selectedRepo && !isNoRepo;

  const { upload } = useFileUpload();
  const createMutation = trpc.sessions.create.useMutation();
  const setInitialAttachmentsMutation = trpc.sessions.setInitialAttachments.useMutation();

  const handleFilesSelected = useCallback((fileList: FileList | null) => {
    if (!fileList || fileList.length === 0) return;
    setError('');
    setFiles((prev) => {
      const combined = [...prev, ...Array.from(fileList)];
      if (combined.length > MAX_ATTACHMENTS) {
        setError(`You can attach at most ${MAX_ATTACHMENTS} files`);
        return combined.slice(0, MAX_ATTACHMENTS);
      }
      return combined;
    });
  }, []);

  const removeFile = useCallback((index: number) => {
    setFiles((prev) => prev.filter((_, i) => i !== index));
  }, []);

  const handleIssueSelect = useCallback(
    (issue: Issue | null) => {
      const generatedPrompt =
        issue && form.selectedRepo
          ? generateIssuePrompt(issue, form.selectedRepo.fullName)
          : undefined;
      dispatch({ type: 'selectIssue', issue, generatedPrompt });
    },
    [form.selectedRepo, dispatch]
  );

  const handleRepoSelect = useCallback(
    (repo: Repo) => {
      // selectRepo resets the rest of the form (name, prompt); clear the
      // separately-held attachments too so nothing carries across the reset.
      dispatch({ type: 'selectRepo', repo });
      setFiles([]);
    },
    [dispatch]
  );

  const handleBranchSelect = useCallback(
    (branch: string) => {
      dispatch({ type: 'selectBranch', branch });
    },
    [dispatch]
  );

  const handleNameChange = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => {
      dispatch({ type: 'editName', name: e.target.value });
    },
    [dispatch]
  );

  const handlePromptChange = useCallback(
    (e: React.ChangeEvent<HTMLTextAreaElement>) => {
      dispatch({ type: 'editPrompt', prompt: e.target.value });
    },
    [dispatch]
  );

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError('');

    if (!form.selectedRepo) {
      setError('Please select a repository or "No Repository"');
      return;
    }

    if (hasRepo && !form.selectedBranch) {
      setError('Please select a branch');
      return;
    }

    const defaultName = (
      isNoRepo ? 'Workspace' : `${form.selectedRepo.name} - ${form.selectedBranch}`
    ).slice(0, SESSION_NAME_MAX_LENGTH);

    setSubmitting(true);
    try {
      const { session } = await createMutation.mutateAsync({
        name: form.sessionName || defaultName,
        repoFullName: isNoRepo ? undefined : form.selectedRepo.fullName,
        branch: isNoRepo ? undefined : form.selectedBranch,
        initialPrompt: form.initialPrompt.trim() || undefined,
        hasInitialAttachments: files.length > 0,
      });

      // Upload the initial prompt's files to the now-created session, then
      // register their stored names so the background setup can prefix them
      // onto the initial prompt once the workspace is ready.
      if (files.length > 0) {
        const uploaded = await upload(session.id, files);
        await setInitialAttachmentsMutation.mutateAsync({
          sessionId: session.id,
          attachments: uploaded.map((a) => a.storedName),
        });
      }

      router.replace(`/session/${session.id}`);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to create session');
      setSubmitting(false);
    }
  };

  const canSubmit = isNoRepo || (hasRepo && !!form.selectedBranch);

  return (
    <form onSubmit={(e) => void handleSubmit(e)} className="space-y-6">
      {error && (
        <Alert variant="destructive">
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      )}

      <RepoSelector selectedRepo={form.selectedRepo} onSelect={handleRepoSelect} />

      {form.selectedRepo && !isNoRepo && (
        <>
          <BranchSelector
            repoFullName={form.selectedRepo.fullName}
            selectedBranch={form.selectedBranch}
            onSelect={handleBranchSelect}
          />

          <IssueSelector
            repoFullName={form.selectedRepo.fullName}
            selectedIssue={form.selectedIssue}
            onSelect={handleIssueSelect}
          />
        </>
      )}

      {form.selectedRepo && (
        <>
          <div className="space-y-2">
            <Label htmlFor="sessionName">Session name (optional)</Label>
            <Input
              id="sessionName"
              type="text"
              value={form.sessionName}
              onChange={handleNameChange}
              maxLength={SESSION_NAME_MAX_LENGTH}
              placeholder={
                isNoRepo
                  ? 'Workspace'
                  : `${form.selectedRepo.name} - ${form.selectedBranch || 'branch'}`
              }
            />
          </div>

          <div className="space-y-2">
            <Label htmlFor="initialPrompt">Initial prompt (optional)</Label>
            <Textarea
              id="initialPrompt"
              value={form.initialPrompt}
              onChange={handlePromptChange}
              placeholder="What should Claude work on?"
              rows={6}
            />
            <p className="text-xs text-muted-foreground">
              If provided, this prompt will be sent to Claude automatically when the session starts.
            </p>
          </div>

          <div className="space-y-2">
            <Label>Attachments (optional)</Label>
            <input
              ref={fileInputRef}
              type="file"
              multiple
              className="hidden"
              onChange={(e) => {
                handleFilesSelected(e.currentTarget.files);
                // Reset so selecting the same file again re-triggers onChange.
                e.currentTarget.value = '';
              }}
            />
            <div className="flex flex-wrap items-center gap-2">
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={() => fileInputRef.current?.click()}
                disabled={submitting || files.length >= MAX_ATTACHMENTS}
              >
                <Paperclip className="mr-1.5 h-4 w-4" />
                Attach files
              </Button>
              {files.map((file, index) => (
                <AttachmentChip
                  key={`${file.name}-${index}`}
                  name={file.name}
                  onRemove={submitting ? undefined : () => removeFile(index)}
                />
              ))}
            </div>
            <p className="text-xs text-muted-foreground">
              Files are uploaded when the session is created and referenced in the initial prompt.
            </p>
          </div>
        </>
      )}

      <div className="flex justify-end gap-3">
        <Button variant="outline" asChild>
          <Link href="/">Cancel</Link>
        </Button>
        <Button type="submit" disabled={!canSubmit || submitting}>
          {submitting ? (
            <span className="flex items-center gap-2">
              <Spinner size="sm" className="text-primary-foreground" />
              Creating...
            </span>
          ) : (
            'Create Session'
          )}
        </Button>
      </div>
    </form>
  );
}

export default function NewSessionPage() {
  return (
    <AuthGuard>
      <div className="min-h-screen bg-background">
        <Header />

        <main className="max-w-2xl mx-auto py-6 sm:px-6 lg:px-8">
          <div className="px-4 py-6 sm:px-0">
            <h1 className="text-2xl font-bold mb-6">New Session</h1>

            <Card>
              <CardHeader>
                <CardTitle>Create a new session</CardTitle>
              </CardHeader>
              <CardContent>
                <NewSessionForm />
              </CardContent>
            </Card>
          </div>
        </main>
      </div>
    </AuthGuard>
  );
}
