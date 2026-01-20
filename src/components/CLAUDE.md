# Components

## Message Display System (`messages/`)

Renders Claude Code JSON streaming messages in the chat UI.

### Architecture

```
MessageList.tsx          # Orchestrates message list, pairs tool calls with results
└── messages/
    ├── MessageBubble.tsx    # Routes messages to appropriate display component
    ├── ToolCallDisplay.tsx  # Generic tool call (collapsible input/output)
    ├── TodoWriteDisplay.tsx # Specialized: checklist with status icons
    ├── ToolResultDisplay.tsx
    ├── SystemInitDisplay.tsx
    ├── ResultDisplay.tsx
    ├── RawJsonDisplay.tsx   # Fallback for unknown message types
    ├── CopyButton.tsx
    └── types.ts             # Shared interfaces
```

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
