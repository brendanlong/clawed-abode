/*
  Warnings:

  - You are about to drop the column `sessionToolsEnabled` on the `GlobalSettings` table. All the data in the column will be lost.
  - You are about to drop the column `createdBySessionId` on the `Session` table. All the data in the column will be lost.

*/
-- RedefineTables
PRAGMA defer_foreign_keys=ON;
PRAGMA foreign_keys=OFF;
CREATE TABLE "new_Session" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "name" TEXT NOT NULL,
    "repoUrl" TEXT,
    "branch" TEXT,
    "repoPath" TEXT NOT NULL DEFAULT '',
    "status" TEXT NOT NULL DEFAULT 'creating',
    "statusMessage" TEXT,
    "currentBranch" TEXT,
    "pullRequestId" TEXT,
    "pullRequest" TEXT,
    "prCheckedAt" DATETIME,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    "lastActivityAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "messageSequence" INTEGER NOT NULL DEFAULT 0,
    "sessionScope" TEXT,
    "claudeModel" TEXT,
    "claudeSessionId" TEXT,
    "agentName" TEXT,
    "sessionToolsEnabled" BOOLEAN NOT NULL DEFAULT false,
    "attentionAt" DATETIME,
    "attentionSummary" TEXT,
    "rateLimitPauseEnabled" BOOLEAN,
    "rateLimitPauseThreshold" INTEGER,
    "resumeAfterRateLimit" BOOLEAN NOT NULL DEFAULT false,
    "queuedPromptSequence" INTEGER NOT NULL DEFAULT 0,
    "usageAlertFiveHour" INTEGER,
    "usageAlertWeekly" INTEGER,
    CONSTRAINT "Session_pullRequestId_fkey" FOREIGN KEY ("pullRequestId") REFERENCES "PullRequest" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);
INSERT INTO "new_Session" ("agentName", "attentionAt", "attentionSummary", "branch", "claudeModel", "claudeSessionId", "createdAt", "currentBranch", "id", "lastActivityAt", "messageSequence", "name", "prCheckedAt", "pullRequest", "pullRequestId", "queuedPromptSequence", "rateLimitPauseEnabled", "rateLimitPauseThreshold", "repoPath", "repoUrl", "resumeAfterRateLimit", "sessionScope", "status", "statusMessage", "updatedAt", "usageAlertFiveHour", "usageAlertWeekly") SELECT "agentName", "attentionAt", "attentionSummary", "branch", "claudeModel", "claudeSessionId", "createdAt", "currentBranch", "id", "lastActivityAt", "messageSequence", "name", "prCheckedAt", "pullRequest", "pullRequestId", "queuedPromptSequence", "rateLimitPauseEnabled", "rateLimitPauseThreshold", "repoPath", "repoUrl", "resumeAfterRateLimit", "sessionScope", "status", "statusMessage", "updatedAt", "usageAlertFiveHour", "usageAlertWeekly" FROM "Session";
-- Sessions the user started keep the management tools if the old global switch gave them out.
UPDATE "new_Session" SET "sessionToolsEnabled" = true
WHERE EXISTS (SELECT 1 FROM "GlobalSettings" WHERE "sessionToolsEnabled" AND "builtinToolsEnabled")
  AND "id" IN (SELECT "id" FROM "Session" WHERE "createdBySessionId" IS NULL);
DROP TABLE "Session";
ALTER TABLE "new_Session" RENAME TO "Session";
CREATE INDEX "Session_lastActivityAt_id_idx" ON "Session"("lastActivityAt", "id");
CREATE INDEX "Session_status_lastActivityAt_id_idx" ON "Session"("status", "lastActivityAt", "id");
CREATE INDEX "Session_agentName_idx" ON "Session"("agentName");
CREATE INDEX "Session_pullRequestId_idx" ON "Session"("pullRequestId");
CREATE TABLE "new_GlobalSettings" (
    "id" TEXT NOT NULL PRIMARY KEY DEFAULT 'global',
    "systemPromptOverride" TEXT,
    "systemPromptOverrideEnabled" BOOLEAN NOT NULL DEFAULT false,
    "systemPromptAppend" TEXT,
    "claudeModel" TEXT,
    "advisorModel" TEXT,
    "claudeApiKey" TEXT,
    "ttsSpeed" REAL,
    "ttsVoice" TEXT,
    "voiceAutoSend" BOOLEAN NOT NULL DEFAULT true,
    "settingSourceUser" BOOLEAN NOT NULL DEFAULT false,
    "settingSourceProject" BOOLEAN NOT NULL DEFAULT true,
    "settingSourceLocal" BOOLEAN NOT NULL DEFAULT false,
    "rateLimitPauseEnabled" BOOLEAN NOT NULL DEFAULT false,
    "rateLimitPauseThreshold" INTEGER NOT NULL DEFAULT 95,
    "builtinToolsEnabled" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);
INSERT INTO "new_GlobalSettings" ("advisorModel", "builtinToolsEnabled", "claudeApiKey", "claudeModel", "createdAt", "id", "rateLimitPauseEnabled", "rateLimitPauseThreshold", "settingSourceLocal", "settingSourceProject", "settingSourceUser", "systemPromptAppend", "systemPromptOverride", "systemPromptOverrideEnabled", "ttsSpeed", "ttsVoice", "updatedAt", "voiceAutoSend") SELECT "advisorModel", "builtinToolsEnabled", "claudeApiKey", "claudeModel", "createdAt", "id", "rateLimitPauseEnabled", "rateLimitPauseThreshold", "settingSourceLocal", "settingSourceProject", "settingSourceUser", "systemPromptAppend", "systemPromptOverride", "systemPromptOverrideEnabled", "ttsSpeed", "ttsVoice", "updatedAt", "voiceAutoSend" FROM "GlobalSettings";
DROP TABLE "GlobalSettings";
ALTER TABLE "new_GlobalSettings" RENAME TO "GlobalSettings";
PRAGMA foreign_keys=ON;
PRAGMA defer_foreign_keys=OFF;
