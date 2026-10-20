-- AlterTable: ADD COLUMN rather than Prisma's generated table rebuild, which
-- would copy every message (gigabytes on a long-lived install).
ALTER TABLE "Message" ADD COLUMN "display" TEXT NOT NULL DEFAULT 'row';

-- Backfill: messageDisplay() in src/lib/transcript-display.ts, restated in SQL.
-- message-store.integration.test.ts checks the two agree. ~30s on a 1M-message DB.
UPDATE "Message" SET "display" = CASE
  WHEN "type" = 'system' THEN CASE
    WHEN json_extract("content", '$.subtype') IN ('task_started', 'task_notification') THEN 'context'
    WHEN json_extract("content", '$.subtype') IN ('error', 'compact_boundary', 'model_refusal_fallback')
      THEN CASE WHEN json_type("content", '$.parent_tool_use_id') = 'text' THEN 'context' ELSE 'row' END
    ELSE 'hidden' END
  WHEN "type" = 'user' AND json_type("content", '$.message.content') = 'array' AND EXISTS (
    SELECT 1 FROM json_each("content", '$.message.content') AS "block"
    WHERE json_extract("block"."value", '$.type') = 'tool_result'
  ) THEN 'context'
  WHEN "type" = 'assistant' AND json_type("content", '$.message.content') = 'array' AND NOT EXISTS (
    SELECT 1 FROM json_each("content", '$.message.content') AS "block"
    WHERE json_extract("block"."value", '$.type') IN ('tool_use', 'redacted_thinking', 'server_tool_use')
      OR (json_extract("block"."value", '$.type') = 'text'
        AND json_type("block"."value", '$.text') = 'text'
        AND trim(json_extract("block"."value", '$.text'), ' ' || char(9, 10, 11, 12, 13)) <> '')
      OR (json_extract("block"."value", '$.type') = 'thinking'
        AND json_type("block"."value", '$.thinking') = 'text'
        AND trim(json_extract("block"."value", '$.thinking'), ' ' || char(9, 10, 11, 12, 13)) <> '')
  ) THEN 'hidden'
  WHEN json_type("content", '$.parent_tool_use_id') = 'text' THEN 'context'
  ELSE 'row' END;

-- CreateIndex
CREATE INDEX "Message_sessionId_display_sequence_idx" ON "Message"("sessionId", "display", "sequence");
