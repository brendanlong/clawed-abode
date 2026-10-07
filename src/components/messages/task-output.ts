/**
 * Split an Agent result into the subagent's answer and its id. The SDK appends
 * an `agentId: …` line (plus usage or background-launch notes) after the answer;
 * the id gets its own field. Takes the last such line, since the answer itself
 * may mention `agentId:`.
 */
export function parseTaskOutput(output: string): { text: string; agentId?: string } {
  const match = [...output.matchAll(/^agentId:\s*(\w+)/gm)].at(-1);
  if (match?.index === undefined) return { text: output };
  return { text: output.slice(0, match.index).trimEnd(), agentId: match[1] };
}
