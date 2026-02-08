-- Unify EnvVar and McpServer models: make repoSettingsId nullable (null = global)
-- Migrate data from GlobalEnvVar/GlobalMcpServer into EnvVar/McpServer before dropping

-- RedefineTables (make repoSettingsId nullable)
PRAGMA defer_foreign_keys=ON;
PRAGMA foreign_keys=OFF;

-- Recreate EnvVar with nullable repoSettingsId
CREATE TABLE "new_EnvVar" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "repoSettingsId" TEXT,
    "name" TEXT NOT NULL,
    "value" TEXT NOT NULL,
    "isSecret" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "EnvVar_repoSettingsId_fkey" FOREIGN KEY ("repoSettingsId") REFERENCES "RepoSettings" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- Copy existing per-repo env vars
INSERT INTO "new_EnvVar" ("id", "repoSettingsId", "name", "value", "isSecret", "createdAt", "updatedAt")
SELECT "id", "repoSettingsId", "name", "value", "isSecret", "createdAt", "updatedAt" FROM "EnvVar";

-- Migrate global env vars (repoSettingsId = NULL means global)
INSERT INTO "new_EnvVar" ("id", "repoSettingsId", "name", "value", "isSecret", "createdAt", "updatedAt")
SELECT "id", NULL, "name", "value", "isSecret", "createdAt", "updatedAt" FROM "GlobalEnvVar";

DROP TABLE "EnvVar";
ALTER TABLE "new_EnvVar" RENAME TO "EnvVar";
CREATE INDEX "EnvVar_repoSettingsId_idx" ON "EnvVar"("repoSettingsId");
CREATE UNIQUE INDEX "EnvVar_repoSettingsId_name_key" ON "EnvVar"("repoSettingsId", "name");
-- Partial unique index: enforce unique name for global env vars (where repoSettingsId IS NULL)
CREATE UNIQUE INDEX "EnvVar_global_name_key" ON "EnvVar"("name") WHERE "repoSettingsId" IS NULL;

-- Recreate McpServer with nullable repoSettingsId
CREATE TABLE "new_McpServer" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "repoSettingsId" TEXT,
    "name" TEXT NOT NULL,
    "type" TEXT NOT NULL DEFAULT 'stdio',
    "command" TEXT NOT NULL DEFAULT '',
    "args" TEXT,
    "env" TEXT,
    "url" TEXT,
    "headers" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "McpServer_repoSettingsId_fkey" FOREIGN KEY ("repoSettingsId") REFERENCES "RepoSettings" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- Copy existing per-repo MCP servers
INSERT INTO "new_McpServer" ("id", "repoSettingsId", "name", "type", "command", "args", "env", "url", "headers", "createdAt", "updatedAt")
SELECT "id", "repoSettingsId", "name", "type", "command", "args", "env", "url", "headers", "createdAt", "updatedAt" FROM "McpServer";

-- Migrate global MCP servers (repoSettingsId = NULL means global)
INSERT INTO "new_McpServer" ("id", "repoSettingsId", "name", "type", "command", "args", "env", "url", "headers", "createdAt", "updatedAt")
SELECT "id", NULL, "name", "type", "command", "args", "env", "url", "headers", "createdAt", "updatedAt" FROM "GlobalMcpServer";

DROP TABLE "McpServer";
ALTER TABLE "new_McpServer" RENAME TO "McpServer";
CREATE INDEX "McpServer_repoSettingsId_idx" ON "McpServer"("repoSettingsId");
CREATE UNIQUE INDEX "McpServer_repoSettingsId_name_key" ON "McpServer"("repoSettingsId", "name");
-- Partial unique index: enforce unique name for global MCP servers (where repoSettingsId IS NULL)
CREATE UNIQUE INDEX "McpServer_global_name_key" ON "McpServer"("name") WHERE "repoSettingsId" IS NULL;

PRAGMA foreign_keys=ON;
PRAGMA defer_foreign_keys=OFF;

-- Now safe to drop the old global tables
DROP INDEX IF EXISTS "GlobalEnvVar_globalSettingsId_name_key";
DROP INDEX IF EXISTS "GlobalEnvVar_globalSettingsId_idx";
DROP INDEX IF EXISTS "GlobalMcpServer_globalSettingsId_name_key";
DROP INDEX IF EXISTS "GlobalMcpServer_globalSettingsId_idx";

PRAGMA foreign_keys=off;
DROP TABLE "GlobalEnvVar";
PRAGMA foreign_keys=on;

PRAGMA foreign_keys=off;
DROP TABLE "GlobalMcpServer";
PRAGMA foreign_keys=on;
