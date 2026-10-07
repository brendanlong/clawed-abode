import { z } from 'zod';

export const ATTENTION_SUMMARY_MAX_LENGTH = 200;

/** Single-line, since it is shown in the session list and as a notification body. */
export const attentionSummarySchema = z
  .string()
  .trim()
  .min(1)
  .max(ATTENTION_SUMMARY_MAX_LENGTH)
  .refine((summary) => !/[\u0000-\u001f\u007f]/.test(summary), {
    message: 'Summary must be a single line',
  });

/** Collapse arbitrary text into something {@link attentionSummarySchema} accepts. */
export function toAttentionSummary(text: string, fallback: string): string {
  const line = text.replace(/[\u0000-\u001f\u007f\s]+/g, ' ').trim();
  if (!line) return fallback;
  if (line.length <= ATTENTION_SUMMARY_MAX_LENGTH) return line;
  return `${line.slice(0, ATTENTION_SUMMARY_MAX_LENGTH - 1).trimEnd()}…`;
}

const askUserQuestionInputSchema = z.object({
  questions: z.array(z.object({ question: z.string() }).loose()).min(1),
});

/**
 * What to tell the user when an interactive tool parks waiting for them, or null
 * for a tool that doesn't wait on the user.
 */
export function interactiveToolAttentionSummary(toolName: string, input: unknown): string | null {
  if (toolName === 'ExitPlanMode') return 'Plan ready for review';
  if (toolName !== 'AskUserQuestion') return null;
  const parsed = askUserQuestionInputSchema.safeParse(input);
  const question = parsed.success ? parsed.data.questions[0].question : '';
  return toAttentionSummary(question, 'Claude has a question for you');
}
