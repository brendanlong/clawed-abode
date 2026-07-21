# Components

Must-knows for the message display system (`messages/`); the upstream message pipeline is documented in `doc/messages-and-sse.md`.

- `MessageList` orchestrates the transcript: it pairs tool calls with results, hides system messages, tightens back-to-back tool-call spacing, and groups/relocates subagent messages. Every one of those decisions is a pure helper in `messageHelpers.ts` — put new list logic there so it stays unit-testable.
- **To add a specialized tool renderer**: create `XxxDisplay.tsx` in `messages/` and register it in `TOOL_DISPLAY_MAP` in `ContentRenderer.tsx`. Unknown tools fall back to the generic `ToolCallDisplay`; unknown message types to `RawJsonDisplay`.
- Both the `Agent` and legacy `Task` tool names must stay mapped to `SubagentToolDisplay`: subagent grouping keys off `parent_tool_use_id` (not the tool name), so the only failure mode is the parent call not routing to `TaskDisplay`, which makes the whole grouped transcript unreachable.
- Subagent transcripts render through the `renderSubagentTranscript` callback on `MessageListContext` rather than a direct import, to avoid a `TaskDisplay` → `MessageBubble` module cycle; nested subagents recurse through the same context.
- The top-level list and each nested `SubagentTranscript` share one visibility predicate, `isVisibleTranscriptMessage(message, pairedMessageIds)`, so the two can't drift; the top-level list layers on only the `getParentToolUseId === null` clause. Hidden system messages must be filtered at both the list level and the bubble render so they leave no empty spacer row.
- Background-subagent boxes are **relocated** (breadcrumb at spawn, live box pinned at the bottom, settled inline at finish) so concurrent main-agent output doesn't read as ungrouped subagent activity. The placement decision is the pure `computeSubagentPlacements` over `collectSubagentLifecycles` — extend there (exhaustively unit-tested); the wiring is covered by `MessageList.test.tsx`. A foreground subagent with nothing interleaved renders inline exactly as before.
- Grouping/relocation is purely a rendering concern — the full transcript still streams and persists unchanged.
