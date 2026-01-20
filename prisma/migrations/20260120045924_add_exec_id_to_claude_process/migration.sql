/*
  Warnings:

  - Added the required column `execId` to the `ClaudeProcess` table without a default value. This is not possible if the table is not empty.

*/
-- RedefineTables
PRAGMA defer_foreign_keys=ON;
PRAGMA foreign_keys=OFF;
CREATE TABLE "new_ClaudeProcess" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "sessionId" TEXT NOT NULL,
    "containerId" TEXT NOT NULL,
    "execId" TEXT NOT NULL,
    "outputFile" TEXT NOT NULL,
    "lastSequence" INTEGER NOT NULL,
    "startedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "ClaudeProcess_sessionId_fkey" FOREIGN KEY ("sessionId") REFERENCES "Session" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);
INSERT INTO "new_ClaudeProcess" ("containerId", "id", "lastSequence", "outputFile", "sessionId", "startedAt") SELECT "containerId", "id", "lastSequence", "outputFile", "sessionId", "startedAt" FROM "ClaudeProcess";
DROP TABLE "ClaudeProcess";
ALTER TABLE "new_ClaudeProcess" RENAME TO "ClaudeProcess";
CREATE UNIQUE INDEX "ClaudeProcess_sessionId_key" ON "ClaudeProcess"("sessionId");
PRAGMA foreign_keys=ON;
PRAGMA defer_foreign_keys=OFF;
