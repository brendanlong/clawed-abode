'use client';

import { Lightbulb, Server } from 'lucide-react';

/**
 * Indicator for a server-side tool call (`server_tool_use` block) — a tool
 * executed inside the Anthropic API, like the advisor tool. There is no
 * expandable input/output: the advisor's response comes back encrypted
 * (`advisor_tool_result` / `advisor_redacted_result`) and is only readable by
 * the model, so all we can show is that the call happened.
 */
export function ServerToolUseDisplay({ name }: { name: string }) {
  const isAdvisor = name === 'advisor';
  const Icon = isAdvisor ? Lightbulb : Server;
  return (
    <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
      <Icon className="h-3.5 w-3.5 shrink-0" />
      <span className="italic">
        {isAdvisor
          ? 'Consulted the advisor (the response is only visible to Claude)'
          : `Used server tool: ${name}`}
      </span>
    </div>
  );
}
