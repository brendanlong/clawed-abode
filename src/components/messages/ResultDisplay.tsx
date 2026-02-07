'use client';

import { useState, useCallback, useMemo } from 'react';
import { cn } from '@/lib/utils';
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible';
import { Badge } from '@/components/ui/badge';
import { MarkdownContent } from '@/components/MarkdownContent';
import { CopyButton } from './CopyButton';
import { formatAsJson } from './types';

interface ModelUsageEntry {
  inputTokens?: number;
  outputTokens?: number;
  cacheReadInputTokens?: number;
  cacheCreationInputTokens?: number;
  webSearchRequests?: number;
  costUSD?: number;
  contextWindow?: number;
  maxOutputTokens?: number;
}

interface PermissionDenial {
  tool_name?: string;
  tool_use_id?: string;
  tool_input?: unknown;
}

interface ResultContent {
  subtype?: string;
  is_error?: boolean;
  result?: string;
  errors?: string[];
  total_cost_usd?: number;
  duration_ms?: number;
  duration_api_ms?: number;
  num_turns?: number;
  usage?: {
    input_tokens?: number;
    output_tokens?: number;
    cache_read_input_tokens?: number;
    cache_creation_input_tokens?: number;
  };
  modelUsage?: Record<string, ModelUsageEntry>;
  permission_denials?: PermissionDenial[];
  [key: string]: unknown;
}

/**
 * Get a human-readable label for the result subtype.
 */
function getResultLabel(subtype?: string): { label: string; isError: boolean } {
  switch (subtype) {
    case 'success':
      return { label: 'Turn Complete', isError: false };
    case 'error_max_turns':
      return { label: 'Max Turns Reached', isError: true };
    case 'error_during_execution':
      return { label: 'Execution Error', isError: true };
    case 'error_max_budget_usd':
      return { label: 'Budget Exceeded', isError: true };
    case 'error_max_structured_output_retries':
      return { label: 'Output Retries Exceeded', isError: true };
    case 'error':
      return { label: 'Error', isError: true };
    default:
      return { label: subtype ?? 'Unknown', isError: false };
  }
}

/**
 * Display for result messages (turn completion with cost/usage info).
 * Handles all result subtypes: success, error_max_turns, error_during_execution,
 * error_max_budget_usd, error_max_structured_output_retries.
 */
export function ResultDisplay({ content }: { content: ResultContent }) {
  const [expanded, setExpanded] = useState(false);
  const getJsonText = useCallback(() => formatAsJson(content), [content]);

  const { label, isError } = useMemo(() => getResultLabel(content.subtype), [content.subtype]);

  const formatCost = (cost?: number) => {
    if (cost === undefined) return 'N/A';
    return `$${cost.toFixed(4)}`;
  };

  const formatTokens = (tokens?: number) => {
    if (tokens === undefined) return 'N/A';
    return tokens.toLocaleString();
  };

  const formatDuration = (ms?: number) => {
    if (ms === undefined) return 'N/A';
    if (ms < 1000) return `${ms}ms`;
    if (ms < 60000) return `${(ms / 1000).toFixed(1)}s`;
    return `${(ms / 60000).toFixed(1)}m`;
  };

  const modelUsageEntries = useMemo(() => {
    if (!content.modelUsage) return [];
    return Object.entries(content.modelUsage);
  }, [content.modelUsage]);

  const permissionDenials = content.permission_denials ?? [];
  const errors = content.errors ?? [];
  const resultText = content.result;

  return (
    <div className="group">
      <Collapsible open={expanded} onOpenChange={setExpanded}>
        <CollapsibleTrigger className="w-full text-left flex items-center gap-2 text-sm hover:bg-muted/50 rounded p-2">
          <Badge
            variant="outline"
            className={cn(
              isError
                ? 'border-red-500 text-red-700 dark:text-red-400'
                : 'border-green-500 text-green-700 dark:text-green-400'
            )}
          >
            {label}
          </Badge>
          <span className="text-muted-foreground text-xs">
            {formatCost(content.total_cost_usd)} · {content.num_turns} turn
            {content.num_turns !== 1 ? 's' : ''} · {formatDuration(content.duration_ms)}
          </span>
          <span className="text-muted-foreground ml-auto">{expanded ? '−' : '+'}</span>
        </CollapsibleTrigger>

        <CollapsibleContent>
          <div className="p-3 space-y-3 text-xs bg-muted/50 rounded mt-1">
            {/* Error messages */}
            {errors.length > 0 && (
              <div className="bg-red-50 dark:bg-red-950 border border-red-200 dark:border-red-800 rounded p-2">
                <div className="text-red-700 dark:text-red-300 font-medium mb-1">Errors:</div>
                {errors.map((err, i) => (
                  <div key={i} className="text-red-600 dark:text-red-400">
                    {err}
                  </div>
                ))}
              </div>
            )}

            {/* Result text for success */}
            {resultText && (
              <div>
                <div className="text-muted-foreground mb-1">Result:</div>
                <div className="bg-background rounded p-2 prose prose-sm dark:prose-invert max-w-none max-h-48 overflow-y-auto">
                  <MarkdownContent content={resultText} />
                </div>
              </div>
            )}

            {/* Duration and cost */}
            <div className="grid grid-cols-2 gap-2">
              <div>
                <span className="text-muted-foreground">Duration:</span>
                <span className="ml-2">{formatDuration(content.duration_ms)}</span>
              </div>
              <div>
                <span className="text-muted-foreground">API Duration:</span>
                <span className="ml-2">{formatDuration(content.duration_api_ms)}</span>
              </div>
              <div>
                <span className="text-muted-foreground">Cost:</span>
                <span className="ml-2">{formatCost(content.total_cost_usd)}</span>
              </div>
              <div>
                <span className="text-muted-foreground">Turns:</span>
                <span className="ml-2">{content.num_turns ?? 'N/A'}</span>
              </div>
            </div>

            {/* Aggregated usage */}
            {content.usage && (
              <div>
                <div className="text-muted-foreground mb-1">Token Usage:</div>
                <div className="grid grid-cols-2 gap-2">
                  <div>
                    <span className="text-muted-foreground">Input:</span>
                    <span className="ml-2">{formatTokens(content.usage.input_tokens)}</span>
                  </div>
                  <div>
                    <span className="text-muted-foreground">Output:</span>
                    <span className="ml-2">{formatTokens(content.usage.output_tokens)}</span>
                  </div>
                  {content.usage.cache_read_input_tokens !== undefined &&
                    content.usage.cache_read_input_tokens > 0 && (
                      <div>
                        <span className="text-muted-foreground">Cache read:</span>
                        <span className="ml-2">
                          {formatTokens(content.usage.cache_read_input_tokens)}
                        </span>
                      </div>
                    )}
                  {content.usage.cache_creation_input_tokens !== undefined &&
                    content.usage.cache_creation_input_tokens > 0 && (
                      <div>
                        <span className="text-muted-foreground">Cache creation:</span>
                        <span className="ml-2">
                          {formatTokens(content.usage.cache_creation_input_tokens)}
                        </span>
                      </div>
                    )}
                </div>
              </div>
            )}

            {/* Per-model usage breakdown */}
            {modelUsageEntries.length > 0 && (
              <div>
                <div className="text-muted-foreground mb-1">Per-Model Usage:</div>
                <div className="space-y-2">
                  {modelUsageEntries.map(([model, usage]) => (
                    <div key={model} className="bg-background rounded p-2">
                      <div className="font-mono text-xs font-medium mb-1">{model}</div>
                      <div className="grid grid-cols-2 gap-1">
                        {usage.inputTokens !== undefined && (
                          <div>
                            <span className="text-muted-foreground">In:</span>
                            <span className="ml-1">{formatTokens(usage.inputTokens)}</span>
                          </div>
                        )}
                        {usage.outputTokens !== undefined && (
                          <div>
                            <span className="text-muted-foreground">Out:</span>
                            <span className="ml-1">{formatTokens(usage.outputTokens)}</span>
                          </div>
                        )}
                        {usage.costUSD !== undefined && (
                          <div>
                            <span className="text-muted-foreground">Cost:</span>
                            <span className="ml-1">{formatCost(usage.costUSD)}</span>
                          </div>
                        )}
                        {usage.contextWindow !== undefined && (
                          <div>
                            <span className="text-muted-foreground">Context:</span>
                            <span className="ml-1">{formatTokens(usage.contextWindow)}</span>
                          </div>
                        )}
                        {usage.webSearchRequests !== undefined && usage.webSearchRequests > 0 && (
                          <div>
                            <span className="text-muted-foreground">Web searches:</span>
                            <span className="ml-1">{usage.webSearchRequests}</span>
                          </div>
                        )}
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            )}

            {/* Permission denials */}
            {permissionDenials.length > 0 && (
              <div>
                <div className="text-muted-foreground mb-1">Permission Denials:</div>
                <div className="bg-yellow-50 dark:bg-yellow-950/50 border border-yellow-200 dark:border-yellow-800 rounded p-2 space-y-1">
                  {permissionDenials.map((denial, i) => (
                    <div key={i} className="flex items-center gap-2">
                      <Badge
                        variant="outline"
                        className="text-xs border-yellow-500 text-yellow-700 dark:text-yellow-400"
                      >
                        {denial.tool_name ?? 'Unknown'}
                      </Badge>
                      {denial.tool_use_id && (
                        <span className="text-muted-foreground font-mono text-xs truncate">
                          {denial.tool_use_id}
                        </span>
                      )}
                    </div>
                  ))}
                </div>
              </div>
            )}
          </div>
        </CollapsibleContent>
      </Collapsible>
      <div className="mt-1">
        <CopyButton getText={getJsonText} />
      </div>
    </div>
  );
}
