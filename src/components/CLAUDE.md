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
    ├── SubagentToolDisplay.tsx # Routes an Agent/Task call to the full TaskDisplay
    │                           #   or a "Subagent started" breadcrumb when relocated
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
  message except `error`, `compact_boundary`, and `model_refusal_fallback` (which
  carry real signal). Both the list-level filter and the bubble-level render check
  it, so a hidden message leaves no empty spacer row. `model_refusal_fallback`
  (a silent Fable→Opus downgrade after an API refusal) renders via
  `RefusalFallbackDisplay` as an amber banner — restored after #312 hid it.
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
  context. `SubagentTranscript` owns its "Subagent activity:" heading and returns
  `null` when every child filters out, so the Task never shows an empty section.
- **Concurrent subagent boxes are relocated.** A background/async subagent runs
  while the main agent generates its own top-level messages, so anchoring its box
  at the spawn point makes that concurrent main-agent work look ungrouped.
  `computeSubagentPlacements` (pure) leaves a compact "Subagent started"
  breadcrumb at the spawn point (`SubagentToolDisplay` picks breadcrumb-vs-box
  from `relocatedSubagentIds` on the context) and either **pins the live box at
  the bottom** while it runs (gated on `isSessionRunning`) or **settles it inline
  at its finish position** (terminal `task_notification`, else last child) once
  done. Foreground subagents with nothing interleaved, and orphaned ones, stay
  inline at spawn — unchanged. See DESIGN.md "Subagent Grouping & Output Density".

The top-level list and each nested `SubagentTranscript` share one row-visibility
predicate, `isVisibleTranscriptMessage(message, pairedMessageIds)`, so the two
lists can't drift; the top-level list layers on only the
`getParentToolUseId === null` clause.

`isRecognizedMessage` only assigns a category to system subtypes that still
render (`error`, `compact_boundary`, `model_refusal_fallback`); `init`/hooks/generic
notices are hidden upstream, so they intentionally have no category.

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
- `systemError` / `systemCompactBoundary` / `systemRefusalFallback` - the only system messages that render
- `result` - Turn completion with cost/usage
- Unknown types fall back to `RawJsonDisplay`
