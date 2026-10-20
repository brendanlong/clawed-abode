-- AlterTable
ALTER TABLE "SessionUsage" ADD COLUMN "lastCallCacheCreationTokens" BIGINT NOT NULL DEFAULT 0;
ALTER TABLE "SessionUsage" ADD COLUMN "lastCallCacheReadTokens" BIGINT NOT NULL DEFAULT 0;
ALTER TABLE "SessionUsage" ADD COLUMN "lastCallInputTokens" BIGINT NOT NULL DEFAULT 0;
ALTER TABLE "SessionUsage" ADD COLUMN "lastCallModel" TEXT;
ALTER TABLE "SessionUsage" ADD COLUMN "lastCallOutputTokens" BIGINT NOT NULL DEFAULT 0;

-- Backfill from stored messages: the same fold messageUsageStatement
-- (src/server/services/session-usage.ts) applies to each new top-level assistant message.
WITH "latest" AS (
  -- SQLite takes bare columns from the MAX() row, so this is each session's latest one.
  SELECT "sessionId", "content", MAX("sequence")
  FROM "Message"
  WHERE "type" = 'assistant'
    AND json_extract("content", '$.parent_tool_use_id') IS NULL
    AND json_type("content", '$.message.usage') = 'object'
  GROUP BY "sessionId"
)
INSERT INTO "SessionUsage" (
  "sessionId", "lastCallInputTokens", "lastCallOutputTokens", "lastCallCacheReadTokens",
  "lastCallCacheCreationTokens", "lastCallModel"
)
SELECT "sessionId",
  COALESCE(json_extract("content", '$.message.usage.input_tokens'), 0),
  COALESCE(json_extract("content", '$.message.usage.output_tokens'), 0),
  COALESCE(json_extract("content", '$.message.usage.cache_read_input_tokens'), 0),
  COALESCE(json_extract("content", '$.message.usage.cache_creation_input_tokens'), 0),
  json_extract("content", '$.message.model')
FROM "latest" WHERE true
ON CONFLICT ("sessionId") DO UPDATE SET
  "lastCallInputTokens" = excluded."lastCallInputTokens",
  "lastCallOutputTokens" = excluded."lastCallOutputTokens",
  "lastCallCacheReadTokens" = excluded."lastCallCacheReadTokens",
  "lastCallCacheCreationTokens" = excluded."lastCallCacheCreationTokens",
  "lastCallModel" = excluded."lastCallModel";
