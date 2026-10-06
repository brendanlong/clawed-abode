-- CreateTable
CREATE TABLE "SessionUsage" (
    "sessionId" TEXT NOT NULL PRIMARY KEY,
    "resultCount" INTEGER NOT NULL DEFAULT 0,
    "inputTokens" BIGINT NOT NULL DEFAULT 0,
    "outputTokens" BIGINT NOT NULL DEFAULT 0,
    "cacheReadTokens" BIGINT NOT NULL DEFAULT 0,
    "cacheCreationTokens" BIGINT NOT NULL DEFAULT 0,
    "closedSegmentsCostUsd" REAL NOT NULL DEFAULT 0,
    "currentSegmentCostUsd" REAL NOT NULL DEFAULT 0,
    "contextWindows" TEXT NOT NULL DEFAULT '{}',
    "model" TEXT,
    CONSTRAINT "SessionUsage_sessionId_fkey" FOREIGN KEY ("sessionId") REFERENCES "Session" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- Backfill from stored messages: the same fold recordMessageUsage
-- (src/server/services/session-usage.ts) applies to each new message.
WITH
"results" AS (
  SELECT "sessionId", "sequence", "content",
    json_extract("content", '$.total_cost_usd') AS "cost"
  FROM "Message"
  WHERE "type" = 'result'
),
"costs" AS (
  SELECT "sessionId", "cost",
    LEAD("cost") OVER (PARTITION BY "sessionId" ORDER BY "sequence") AS "nextCost"
  FROM "results"
  WHERE "cost" IS NOT NULL
),
"costTotals" AS (
  -- A drop in the cumulative cost marks a reset query process; a segment's
  -- final value is the one followed by a drop, the current one has no successor.
  SELECT "sessionId",
    TOTAL(CASE WHEN "nextCost" < "cost" THEN "cost" END) AS "closed",
    TOTAL(CASE WHEN "nextCost" IS NULL THEN "cost" END) AS "current"
  FROM "costs"
  GROUP BY "sessionId"
),
"tokenTotals" AS (
  SELECT "sessionId",
    COUNT(*) AS "resultCount",
    COALESCE(SUM(json_extract("content", '$.usage.input_tokens')), 0) AS "inputTokens",
    COALESCE(SUM(json_extract("content", '$.usage.output_tokens')), 0) AS "outputTokens",
    COALESCE(SUM(json_extract("content", '$.usage.cache_read_input_tokens')), 0) AS "cacheReadTokens",
    COALESCE(SUM(json_extract("content", '$.usage.cache_creation_input_tokens')), 0) AS "cacheCreationTokens"
  FROM "results"
  GROUP BY "sessionId"
),
"windows" AS (
  SELECT "r"."sessionId", "m"."key" AS "model",
    json_extract("m"."value", '$.contextWindow') AS "contextWindow", "r"."sequence"
  FROM "results" AS "r", json_each("r"."content", '$.modelUsage') AS "m"
),
"latestWindows" AS (
  -- SQLite takes bare columns from the MAX() row, so this is each model's latest window.
  SELECT "sessionId", "model", "contextWindow", MAX("sequence")
  FROM "windows"
  WHERE "contextWindow" > 0
  GROUP BY "sessionId", "model"
),
"windowTotals" AS (
  SELECT "sessionId", json_group_object("model", "contextWindow") AS "contextWindows"
  FROM "latestWindows"
  GROUP BY "sessionId"
),
"inits" AS (
  SELECT "sessionId", json_extract("content", '$.model') AS "model",
    ROW_NUMBER() OVER (PARTITION BY "sessionId" ORDER BY "sequence") AS "rn"
  FROM "Message"
  WHERE "type" = 'system'
    AND json_extract("content", '$.subtype') = 'init'
    AND json_extract("content", '$.model') IS NOT NULL
),
"sessions" AS (
  SELECT "sessionId" FROM "tokenTotals"
  UNION
  SELECT "sessionId" FROM "inits"
)
INSERT INTO "SessionUsage" (
  "sessionId", "resultCount", "inputTokens", "outputTokens", "cacheReadTokens",
  "cacheCreationTokens", "closedSegmentsCostUsd", "currentSegmentCostUsd", "contextWindows", "model"
)
SELECT "s"."sessionId",
  COALESCE("t"."resultCount", 0),
  COALESCE("t"."inputTokens", 0),
  COALESCE("t"."outputTokens", 0),
  COALESCE("t"."cacheReadTokens", 0),
  COALESCE("t"."cacheCreationTokens", 0),
  COALESCE("c"."closed", 0),
  COALESCE("c"."current", 0),
  COALESCE("w"."contextWindows", '{}'),
  "i"."model"
FROM "sessions" AS "s"
LEFT JOIN "tokenTotals" AS "t" ON "t"."sessionId" = "s"."sessionId"
LEFT JOIN "costTotals" AS "c" ON "c"."sessionId" = "s"."sessionId"
LEFT JOIN "windowTotals" AS "w" ON "w"."sessionId" = "s"."sessionId"
LEFT JOIN "inits" AS "i" ON "i"."sessionId" = "s"."sessionId" AND "i"."rn" = 1;
