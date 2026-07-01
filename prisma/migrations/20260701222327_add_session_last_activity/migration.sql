-- RedefineTables
PRAGMA defer_foreign_keys=ON;
PRAGMA foreign_keys=OFF;
CREATE TABLE "new_Session" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "name" TEXT NOT NULL,
    "repoUrl" TEXT,
    "branch" TEXT,
    "workspacePath" TEXT NOT NULL DEFAULT '',
    "repoPath" TEXT NOT NULL DEFAULT '',
    "status" TEXT NOT NULL DEFAULT 'creating',
    "statusMessage" TEXT,
    "initialPrompt" TEXT,
    "currentBranch" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    "lastActivityAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "archivedAt" DATETIME
);
INSERT INTO "new_Session" ("archivedAt", "branch", "createdAt", "currentBranch", "id", "initialPrompt", "name", "repoPath", "repoUrl", "status", "statusMessage", "updatedAt", "workspacePath") SELECT "archivedAt", "branch", "createdAt", "currentBranch", "id", "initialPrompt", "name", "repoPath", "repoUrl", "status", "statusMessage", "updatedAt", "workspacePath" FROM "Session";
DROP TABLE "Session";
ALTER TABLE "new_Session" RENAME TO "Session";
CREATE INDEX "Session_status_idx" ON "Session"("status");
PRAGMA foreign_keys=ON;
PRAGMA defer_foreign_keys=OFF;

-- Backfill: preserve ordering for existing sessions using their last user
-- interaction (latest user-typed message, falling back to updatedAt).
UPDATE "Session" SET "lastActivityAt" = COALESCE(
    (SELECT MAX(m."createdAt") FROM "Message" m WHERE m."sessionId" = "Session"."id" AND m."type" = 'user'),
    "updatedAt"
);
