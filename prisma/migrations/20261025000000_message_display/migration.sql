-- Prisma doesn't wrap SQLite migrations in a transaction; without one, a
-- failure after the ALTER would leave the column behind and every retry would
-- fail on it.
BEGIN;

-- AlterTable: ADD COLUMN rather than Prisma's generated table rebuild, which
-- would copy every message (gigabytes on a long-lived install).
ALTER TABLE "Message" ADD COLUMN "display" TEXT NOT NULL DEFAULT 'row';

-- Backfill: messageDisplay() in src/lib/transcript-display.ts, restated in SQL.
-- message-store.integration.test.ts checks the two agree. Only rows that aren't
-- the default are written. Blocks are read by path into "content" (never
-- json_extract on a block's own value, which is plain text for a string block
-- and would abort the migration as malformed JSON). Blank text is ASCII
-- whitespace only (space, \t, \n, \v, \f, \r), as in the classifier.
UPDATE "Message" SET "display" = "classified"."display"
FROM (
  SELECT "rowid" AS "messageRowid", CASE
    WHEN "type" = 'system' THEN CASE
      WHEN json_extract("content", '$.subtype') IN ('task_started', 'task_notification') THEN 'context'
      WHEN json_extract("content", '$.subtype') IN ('error', 'compact_boundary', 'model_refusal_fallback')
        THEN CASE WHEN json_type("content", '$.parent_tool_use_id') = 'text' THEN 'context' ELSE 'row' END
      ELSE 'hidden' END
    WHEN "type" = 'user' AND json_type("content", '$.message.content') = 'array' AND EXISTS (
      SELECT 1 FROM json_each("content", '$.message.content') AS "block"
      WHERE json_extract("content", "block"."fullkey" || '.type') = 'tool_result'
    ) THEN 'context'
    WHEN "type" = 'assistant' AND json_type("content", '$.message.content') = 'array' AND NOT EXISTS (
      SELECT 1 FROM json_each("content", '$.message.content') AS "block"
      WHERE json_extract("content", "block"."fullkey" || '.type') IN ('tool_use', 'redacted_thinking', 'server_tool_use')
        OR (json_extract("content", "block"."fullkey" || '.type') = 'text'
          AND json_type("content", "block"."fullkey" || '.text') = 'text'
          AND trim(json_extract("content", "block"."fullkey" || '.text'), ' ' || char(9, 10, 11, 12, 13)) <> '')
        OR (json_extract("content", "block"."fullkey" || '.type') = 'thinking'
          AND json_type("content", "block"."fullkey" || '.thinking') = 'text'
          AND trim(json_extract("content", "block"."fullkey" || '.thinking'), ' ' || char(9, 10, 11, 12, 13)) <> '')
    ) THEN 'hidden'
    WHEN json_type("content", '$.parent_tool_use_id') = 'text' THEN 'context'
    ELSE 'row' END AS "display"
  FROM "Message"
) AS "classified"
WHERE "Message"."rowid" = "classified"."messageRowid" AND "classified"."display" <> 'row';

-- CreateIndex
CREATE INDEX "Message_sessionId_display_sequence_idx" ON "Message"("sessionId", "display", "sequence");

COMMIT;
