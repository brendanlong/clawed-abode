'use client';

import { useState, useCallback } from 'react';
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
  const [selectedRepo, setSelectedRepo] = useState<Repo | null>(null);
  const [selectedBranch, setSelectedBranch] = useState('');
  const [selectedIssue, setSelectedIssue] = useState<Issue | null>(null);
  const [sessionName, setSessionName] = useState('');
  const [error, setError] = useState('');

  const createMutation = trpc.sessions.create.useMutation({
    onSuccess: (data) => {
      router.replace(`/session/${data.session.id}`);
    },
    onError: (err) => {
      setError(err.message);
    },
  });

  // When an issue is selected, use its title as the session name
  const handleIssueSelect = useCallback((issue: Issue | null) => {
    setSelectedIssue(issue);
    if (issue) {
      setSessionName(`#${issue.number}: ${issue.title}`);
    } else {
      setSessionName('');
    }
  }, []);

  // Handle repo selection: reset branch, issue, and name
  const handleRepoSelect = useCallback((repo: Repo) => {
    setSelectedRepo(repo);
    setSelectedBranch('');
    setSelectedIssue(null);
    setSessionName('');
  }, []);

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    setError('');

    if (!selectedRepo) {
      setError('Please select a repository');
      return;
    }

    if (!selectedBranch) {
      setError('Please select a branch');
      return;
    }

    const initialPrompt = selectedIssue
      ? generateIssuePrompt(selectedIssue, selectedRepo.fullName)
      : undefined;

    createMutation.mutate({
      name: sessionName || `${selectedRepo.name} - ${selectedBranch}`,
      repoFullName: selectedRepo.fullName,
      branch: selectedBranch,
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

      <RepoSelector selectedRepo={selectedRepo} onSelect={handleRepoSelect} />

      {selectedRepo && (
        <>
          <BranchSelector
            repoFullName={selectedRepo.fullName}
            selectedBranch={selectedBranch}
            onSelect={setSelectedBranch}
          />

          <IssueSelector
            repoFullName={selectedRepo.fullName}
            selectedIssue={selectedIssue}
            onSelect={handleIssueSelect}
          />

          <div className="space-y-2">
            <Label htmlFor="sessionName">Session name {selectedIssue ? '' : '(optional)'}</Label>
            <Input
              id="sessionName"
              type="text"
              value={sessionName}
              onChange={(e) => setSessionName(e.target.value)}
              placeholder={`${selectedRepo.name} - ${selectedBranch || 'branch'}`}
            />
            {selectedIssue && (
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
          disabled={!selectedRepo || !selectedBranch || createMutation.isPending}
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
