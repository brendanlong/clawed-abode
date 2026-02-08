-- RedefineTables
PRAGMA defer_foreign_keys=ON;
PRAGMA foreign_keys=OFF;
CREATE TABLE "new_McpServer" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "repoSettingsId" TEXT NOT NULL,
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
INSERT INTO "new_McpServer" ("args", "command", "createdAt", "env", "id", "name", "repoSettingsId", "updatedAt") SELECT "args", "command", "createdAt", "env", "id", "name", "repoSettingsId", "updatedAt" FROM "McpServer";
DROP TABLE "McpServer";
ALTER TABLE "new_McpServer" RENAME TO "McpServer";
CREATE INDEX "McpServer_repoSettingsId_idx" ON "McpServer"("repoSettingsId");
CREATE UNIQUE INDEX "McpServer_repoSettingsId_name_key" ON "McpServer"("repoSettingsId", "name");
PRAGMA foreign_keys=ON;
PRAGMA defer_foreign_keys=OFF;
