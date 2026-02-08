'use client';

import { useState, useCallback, useReducer } from 'react';
import { useRouter } from 'next/navigation';
import Link from 'next/link';
import { AuthGuard } from '@/components/AuthGuard';
import { Header } from '@/components/Header';
import { trpc } from '@/lib/trpc';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Spinner } from '@/components/ui/spinner';
import { RepoSelector } from '@/components/RepoSelector';
import { BranchSelector } from '@/components/BranchSelector';
import { IssueSelector } from '@/components/IssueSelector';
import type { Repo } from '@/components/RepoSelector';
import type { Issue } from '@/lib/types';
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

  const createMutation = trpc.sessions.create.useMutation({
    onSuccess: (data) => {
      router.replace(`/session/${data.session.id}`);
    },
    onError: (err) => {
      setError(err.message);
    },
  });

  const handleIssueSelect = useCallback((issue: Issue | null) => {
    dispatch({ type: 'selectIssue', issue });
  }, []);

  const handleRepoSelect = useCallback((repo: Repo) => {
    dispatch({ type: 'selectRepo', repo });
  }, []);

  const handleBranchSelect = useCallback((branch: string) => {
    dispatch({ type: 'selectBranch', branch });
  }, []);

  const handleNameChange = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    dispatch({ type: 'editName', name: e.target.value });
  }, []);

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    setError('');

    if (!form.selectedRepo) {
      setError('Please select a repository');
      return;
    }

    if (!form.selectedBranch) {
      setError('Please select a branch');
      return;
    }

    const initialPrompt = form.selectedIssue
      ? generateIssuePrompt(form.selectedIssue, form.selectedRepo.fullName)
      : undefined;

    createMutation.mutate({
      name: form.sessionName || `${form.selectedRepo.name} - ${form.selectedBranch}`,
      repoFullName: form.selectedRepo.fullName,
      branch: form.selectedBranch,
      initialPrompt,
    });
  };

  return (
    <form onSubmit={handleSubmit} className="space-y-6">
      {error && (
        <Alert variant="destructive">
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      )}

      <RepoSelector selectedRepo={form.selectedRepo} onSelect={handleRepoSelect} />

      {form.selectedRepo && (
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

          <div className="space-y-2">
            <Label htmlFor="sessionName">
              Session name {form.selectedIssue ? '' : '(optional)'}
            </Label>
            <Input
              id="sessionName"
              type="text"
              value={form.sessionName}
              onChange={handleNameChange}
              placeholder={`${form.selectedRepo.name} - ${form.selectedBranch || 'branch'}`}
            />
            {form.selectedIssue && (
              <p className="text-xs text-muted-foreground">
                When the session starts, Claude will automatically be prompted to fix this issue.
              </p>
            )}
          </div>
        </>
      )}

      <div className="flex justify-end gap-3">
        <Button variant="outline" asChild>
          <Link href="/">Cancel</Link>
        </Button>
        <Button
          type="submit"
          disabled={!form.selectedRepo || !form.selectedBranch || createMutation.isPending}
        >
          {createMutation.isPending ? (
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
