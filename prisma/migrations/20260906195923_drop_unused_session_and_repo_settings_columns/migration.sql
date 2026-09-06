/*
  Warnings:

  - You are about to drop the column `displayOrder` on the `RepoSettings` table. All the data in the column will be lost.
  - You are about to drop the column `archivedAt` on the `Session` table. All the data in the column will be lost.
  - You are about to drop the column `initialPrompt` on the `Session` table. All the data in the column will be lost.
  - You are about to drop the column `workspacePath` on the `Session` table. All the data in the column will be lost.

*/
-- RedefineTables
PRAGMA defer_foreign_keys=ON;
PRAGMA foreign_keys=OFF;
CREATE TABLE "new_RepoSettings" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "repoFullName" TEXT NOT NULL,
    "isFavorite" BOOLEAN NOT NULL DEFAULT false,
    "customSystemPrompt" TEXT,
    "claudeModel" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);
INSERT INTO "new_RepoSettings" ("claudeModel", "createdAt", "customSystemPrompt", "id", "isFavorite", "repoFullName", "updatedAt") SELECT "claudeModel", "createdAt", "customSystemPrompt", "id", "isFavorite", "repoFullName", "updatedAt" FROM "RepoSettings";
DROP TABLE "RepoSettings";
ALTER TABLE "new_RepoSettings" RENAME TO "RepoSettings";
CREATE UNIQUE INDEX "RepoSettings_repoFullName_key" ON "RepoSettings"("repoFullName");
CREATE INDEX "RepoSettings_isFavorite_idx" ON "RepoSettings"("isFavorite");
CREATE TABLE "new_Session" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "name" TEXT NOT NULL,
    "repoUrl" TEXT,
    "branch" TEXT,
    "repoPath" TEXT NOT NULL DEFAULT '',
    "status" TEXT NOT NULL DEFAULT 'creating',
    "statusMessage" TEXT,
    "currentBranch" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    "lastActivityAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "messageSequence" INTEGER NOT NULL DEFAULT 0,
    "sessionScope" TEXT,
    "claudeModel" TEXT
);
INSERT INTO "new_Session" ("branch", "claudeModel", "createdAt", "currentBranch", "id", "lastActivityAt", "messageSequence", "name", "repoPath", "repoUrl", "sessionScope", "status", "statusMessage", "updatedAt") SELECT "branch", "claudeModel", "createdAt", "currentBranch", "id", "lastActivityAt", "messageSequence", "name", "repoPath", "repoUrl", "sessionScope", "status", "statusMessage", "updatedAt" FROM "Session";
DROP TABLE "Session";
ALTER TABLE "new_Session" RENAME TO "Session";
CREATE INDEX "Session_status_idx" ON "Session"("status");
PRAGMA foreign_keys=ON;
PRAGMA defer_foreign_keys=OFF;
