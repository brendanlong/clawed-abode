# Components

## Message Display System (`messages/`)

Renders Claude Code JSON streaming messages in the chat UI.

### Architecture

```
MessageList.tsx          # Orchestrates message list, pairs tool calls with results,
│                        #   groups subagent messages, spaces back-to-back tool calls
└── messages/
    ├── MessageBubble.tsx       # Routes messages to appropriate display component
    ├── ToolCallDisplay.tsx     # Generic tool call (collapsible input/output)
    ├── TodoWriteDisplay.tsx    # Specialized: checklist with status icons
    ├── ToolResultDisplay.tsx
    ├── TaskDisplay.tsx         # Subagent Task; nests the subagent's transcript
    ├── SubagentTranscript.tsx  # Nested transcript rendered inside a TaskDisplay
    ├── ResultDisplay.tsx
    ├── RawJsonDisplay.tsx      # Fallback for unknown message types
    ├── CopyButton.tsx
    └── types.ts                # Shared interfaces
```

### Output Density (issue #312)

To keep the transcript focused, `MessageList` / `MessageBubble` apply three rules
(all derived from pure helpers in `messageHelpers.ts`, so they're unit-tested):

- **System messages are hidden.** `isHiddenSystemMessage` drops every `system`
  message except `error` and `compact_boundary` (which carry real signal). Both
  the list-level filter and the bubble-level render check it, so a hidden message
  leaves no empty spacer row.
- **Back-to-back tool calls are tightly packed.** The list has no blanket
  `space-y`; each row computes its own top margin. Two consecutive
  `isToolCallOnlyMessage` rows (assistant messages that are only tool calls, no
  text) get `mt-1` instead of the usual `mt-4`.
- **Subagent messages are grouped.** Messages with a `parent_tool_use_id`
  (`groupSubagentMessages`) are pulled out of the top-level list and rendered,
  collapsed, inside their parent `TaskDisplay` via
  `renderSubagentTranscript` on `MessageListContext` (a callback rather than a
  direct import, to avoid a `TaskDisplay` → `MessageBubble` cycle). Nesting works
  recursively because a nested Task inside a subagent transcript reads the same
  context.

### Adding a Specialized Tool Renderer

1. Create `XxxDisplay.tsx` in `messages/`
2. In `MessageBubble.tsx`, add detection in `renderContentBlocks()`:
   ```tsx
   if (block.name === 'YourToolName') {
     return <YourToolDisplay key={block.id} tool={tool} />;
   }
   ```
3. Export from `messages/index.ts`

### Message Type Detection

`isRecognizedMessage()` categorizes messages:

- `assistant` - Claude responses with text/tool_use blocks
- `user` - User prompts or tool results
- `systemInit` - Session started metadata
- `result` - Turn completion with cost/usage
- Unknown types fall back to `RawJsonDisplay`
