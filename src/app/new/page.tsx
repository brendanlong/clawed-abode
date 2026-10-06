'use client';

import { useCallback, useReducer } from 'react';
import { useRouter } from 'next/navigation';
import Link from 'next/link';
import { AuthGuard } from '@/components/AuthGuard';
import { Header } from '@/components/Header';
import { trpc } from '@/lib/trpc';
import { fallbackClaudeModel } from '@/lib/claude-model';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { Label } from '@/components/ui/label';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Spinner } from '@/components/ui/spinner';
import { RepoSelector } from '@/components/RepoSelector';
import { NO_REPO_SENTINEL } from '@/lib/repo-full-name';
import { BranchSelector, useBranchList } from '@/components/BranchSelector';
import { IssueSelector } from '@/components/IssueSelector';
import { ModelCombobox } from '@/components/settings/shared/ModelCombobox';
import { Cpu } from 'lucide-react';
import type { Issue } from '@/lib/types';
import { SESSION_NAME_MAX_LENGTH } from '@/lib/types';
import { generateIssuePrompt } from '@/lib/issue-prompt';
import { formReducer, initialFormState } from './form-reducer';
import {
  buildCreateSessionInput,
  formDefaultSessionName,
  resolveBranch,
} from './create-session-input';

function NewSessionForm() {
  const router = useRouter();
  const [form, dispatch] = useReducer(formReducer, initialFormState);

  const isNoRepo = form.selectedRepo?.fullName === NO_REPO_SENTINEL;

  const { data: globalSettings } = trpc.globalSettings.get.useQuery();
  const fallbackModel = fallbackClaudeModel(globalSettings);

  const { data: branchList } = useBranchList(
    form.selectedRepo && !isNoRepo ? form.selectedRepo.fullName : ''
  );
  const branch = resolveBranch(form.selectedBranch, branchList);
  const input = buildCreateSessionInput(form, branch);

  const createMutation = trpc.sessions.create.useMutation({
    onSuccess: (data) => {
      router.replace(`/session/${data.session.id}`);
    },
  });

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

  // Submit stays disabled until the form is valid, so a validation error never
  // needs showing; the only error to report is the server's.
  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (input) createMutation.mutate(input);
  };

  return (
    <form onSubmit={handleSubmit} className="space-y-6">
      {createMutation.error && (
        <Alert variant="destructive">
          <AlertDescription>{createMutation.error.message}</AlertDescription>
        </Alert>
      )}

      <RepoSelector
        selectedRepo={form.selectedRepo}
        onSelect={(repo) => dispatch({ type: 'selectRepo', repo })}
      />

      {form.selectedRepo && !isNoRepo && (
        <>
          <BranchSelector
            repoFullName={form.selectedRepo.fullName}
            selectedBranch={branch}
            onSelect={(picked) => dispatch({ type: 'selectBranch', branch: picked })}
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
              onChange={(e) => dispatch({ type: 'editName', name: e.target.value })}
              maxLength={SESSION_NAME_MAX_LENGTH}
              placeholder={formDefaultSessionName(form.selectedRepo, branch || 'branch')}
            />
          </div>

          <div className="space-y-2">
            <Label htmlFor="initialPrompt">Initial prompt (optional)</Label>
            <Textarea
              id="initialPrompt"
              value={form.initialPrompt}
              onChange={(e) => dispatch({ type: 'editPrompt', prompt: e.target.value })}
              placeholder="What should Claude work on?"
              rows={6}
            />
            <p className="text-xs text-muted-foreground">
              If provided, this prompt will be sent to Claude automatically when the session starts.
            </p>
          </div>

          <div className="space-y-2">
            <Label htmlFor="claudeModel" className="flex items-center gap-1.5">
              <Cpu className="h-4 w-4 text-muted-foreground" />
              Claude model (optional)
            </Label>
            <ModelCombobox
              id="claudeModel"
              value={form.claudeModel ?? ''}
              onChange={(value) => dispatch({ type: 'editModel', claudeModel: value || null })}
              placeholder={fallbackModel}
            />
            <p className="text-xs text-muted-foreground">
              Overrides the model for this session only. You can change it later from the session
              header.
            </p>
          </div>
        </>
      )}

      <div className="flex justify-end gap-3">
        <Button variant="outline" asChild>
          <Link href="/">Cancel</Link>
        </Button>
        <Button type="submit" disabled={!input || createMutation.isPending}>
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
