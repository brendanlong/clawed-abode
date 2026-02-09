/**
 * Shared types for the SSE protocol between the agent service and the main Next.js app.
 *
 * These types define the contract for streaming messages from the agent service
 * (running inside Podman containers) to the main app. Both sides must agree on
 * these shapes for the protocol to work correctly.
 */

/**
 * A partial assistant message built from accumulated stream events.
 * Shaped to match the assistant message content structure so the frontend
 * can render it identically to a complete message.
 *
 * Produced by the agent service's StreamAccumulator and consumed by the
 * main app's agent client.
 */
export interface PartialAssistantMessage {
  type: 'assistant';
  /** Whether this is a partial (in-progress) message */
  partial: true;
  message: {
    role: 'assistant';
    content: Array<
      | { type: 'text'; text: string }
      | { type: 'tool_use'; id: string; name: string; input: Record<string, unknown> }
    >;
    model?: string;
    stop_reason?: string | null;
  };
  parent_tool_use_id: string | null;
  uuid: string;
  session_id: string;
}
