-- Hand-written (Prisma can't express CHECK; see the note in schema.prisma): CHECK
-- constraints for stringly-typed columns that code parses with Zod, so a corrupt
-- row can't be stored in the first place.
--
-- SQLite can't add a CHECK to an existing table, hence the table rebuilds. The
-- copies use INSERT OR IGNORE, which skips rows that violate the new CHECKs, so
-- existing corrupt MCP servers (which break loading the settings page they'd be
-- deleted from) are dropped along with their values and OAuth grant. Corrupt JSON
-- in QueuedPrompt/SessionUsage is reset to empty instead: deleting would lose a
-- queued prompt or a session's usage totals.
--
-- Foreign keys are off so dropping a parent doesn't cascade-delete the children
-- of the rows being kept; orphans of the skipped rows are deleted explicitly.

PRAGMA defer_foreign_keys=ON;
PRAGMA foreign_keys=OFF;

CREATE TABLE "new_McpServer" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "repoSettingsId" TEXT,
    "name" TEXT NOT NULL,
    "type" TEXT NOT NULL DEFAULT 'stdio',
    "command" TEXT NOT NULL DEFAULT '',
    "args" TEXT,
    "url" TEXT,
    "authType" TEXT NOT NULL DEFAULT 'headers',
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "McpServer_repoSettingsId_fkey" FOREIGN KEY ("repoSettingsId") REFERENCES "RepoSettings" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "McpServer_type_check" CHECK ("type" IN ('stdio', 'http', 'sse')),
    CONSTRAINT "McpServer_authType_check" CHECK ("authType" IN ('headers', 'oauth')),
    CONSTRAINT "McpServer_args_check" CHECK ("args" IS NULL OR (CASE WHEN json_valid("args") THEN json_type("args") = 'array' ELSE 0 END)),
    CONSTRAINT "McpServer_url_check" CHECK ("type" = 'stdio' OR ("url" IS NOT NULL AND "url" <> ''))
);
INSERT OR IGNORE INTO "new_McpServer" ("id", "repoSettingsId", "name", "type", "command", "args", "url", "authType", "createdAt", "updatedAt")
SELECT "id", "repoSettingsId", "name", "type", "command", "args", "url", "authType", "createdAt", "updatedAt" FROM "McpServer";
DROP TABLE "McpServer";
ALTER TABLE "new_McpServer" RENAME TO "McpServer";
CREATE INDEX "McpServer_repoSettingsId_idx" ON "McpServer"("repoSettingsId");
CREATE UNIQUE INDEX "McpServer_repoSettingsId_name_key" ON "McpServer"("repoSettingsId", "name");
CREATE UNIQUE INDEX "McpServer_global_name_key" ON "McpServer"("name") WHERE "repoSettingsId" IS NULL;

CREATE TABLE "new_McpServerValue" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "mcpServerId" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "value" TEXT NOT NULL,
    "isSecret" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "McpServerValue_mcpServerId_fkey" FOREIGN KEY ("mcpServerId") REFERENCES "McpServer" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "McpServerValue_kind_check" CHECK ("kind" IN ('env', 'header'))
);
INSERT OR IGNORE INTO "new_McpServerValue" ("id", "mcpServerId", "kind", "name", "value", "isSecret", "createdAt", "updatedAt")
SELECT "id", "mcpServerId", "kind", "name", "value", "isSecret", "createdAt", "updatedAt" FROM "McpServerValue"
WHERE "mcpServerId" IN (SELECT "id" FROM "McpServer");
DROP TABLE "McpServerValue";
ALTER TABLE "new_McpServerValue" RENAME TO "McpServerValue";
CREATE UNIQUE INDEX "McpServerValue_mcpServerId_kind_name_key" ON "McpServerValue"("mcpServerId", "kind", "name");

DELETE FROM "McpOAuth" WHERE "mcpServerId" NOT IN (SELECT "id" FROM "McpServer");

CREATE TABLE "new_QueuedPrompt" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "sessionId" TEXT NOT NULL,
    "position" INTEGER NOT NULL,
    "messageId" TEXT NOT NULL,
    "content" TEXT NOT NULL,
    "text" TEXT NOT NULL,
    "attachments" TEXT NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "QueuedPrompt_sessionId_fkey" FOREIGN KEY ("sessionId") REFERENCES "Session" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "QueuedPrompt_attachments_check" CHECK (CASE WHEN json_valid("attachments") THEN json_type("attachments") = 'array' ELSE 0 END)
);
UPDATE "QueuedPrompt" SET "attachments" = '[]'
WHERE NOT (CASE WHEN json_valid("attachments") THEN json_type("attachments") = 'array' ELSE 0 END);
INSERT INTO "new_QueuedPrompt" ("id", "sessionId", "position", "messageId", "content", "text", "attachments", "createdAt")
SELECT "id", "sessionId", "position", "messageId", "content", "text", "attachments", "createdAt" FROM "QueuedPrompt";
DROP TABLE "QueuedPrompt";
ALTER TABLE "new_QueuedPrompt" RENAME TO "QueuedPrompt";
CREATE UNIQUE INDEX "QueuedPrompt_sessionId_position_key" ON "QueuedPrompt"("sessionId", "position");

CREATE TABLE "new_SessionUsage" (
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
    CONSTRAINT "SessionUsage_sessionId_fkey" FOREIGN KEY ("sessionId") REFERENCES "Session" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "SessionUsage_contextWindows_check" CHECK (CASE WHEN json_valid("contextWindows") THEN json_type("contextWindows") = 'object' ELSE 0 END)
);
UPDATE "SessionUsage" SET "contextWindows" = '{}'
WHERE NOT (CASE WHEN json_valid("contextWindows") THEN json_type("contextWindows") = 'object' ELSE 0 END);
INSERT INTO "new_SessionUsage" ("sessionId", "resultCount", "inputTokens", "outputTokens", "cacheReadTokens", "cacheCreationTokens", "closedSegmentsCostUsd", "currentSegmentCostUsd", "contextWindows", "model")
SELECT "sessionId", "resultCount", "inputTokens", "outputTokens", "cacheReadTokens", "cacheCreationTokens", "closedSegmentsCostUsd", "currentSegmentCostUsd", "contextWindows", "model" FROM "SessionUsage";
DROP TABLE "SessionUsage";
ALTER TABLE "new_SessionUsage" RENAME TO "SessionUsage";

PRAGMA foreign_keys=ON;
PRAGMA defer_foreign_keys=OFF;
