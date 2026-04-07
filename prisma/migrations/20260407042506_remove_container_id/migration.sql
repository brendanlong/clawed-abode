/*
  Warnings:

  - You are about to drop the column `containerId` on the `Session` table. All the data in the column will be lost.

*/
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
    "archivedAt" DATETIME
);
INSERT INTO "new_Session" ("archivedAt", "branch", "createdAt", "currentBranch", "id", "initialPrompt", "name", "repoPath", "repoUrl", "status", "statusMessage", "updatedAt", "workspacePath") SELECT "archivedAt", "branch", "createdAt", "currentBranch", "id", "initialPrompt", "name", "repoPath", "repoUrl", "status", "statusMessage", "updatedAt", "workspacePath" FROM "Session";
DROP TABLE "Session";
ALTER TABLE "new_Session" RENAME TO "Session";
CREATE INDEX "Session_status_idx" ON "Session"("status");
PRAGMA foreign_keys=ON;
PRAGMA defer_foreign_keys=OFF;
