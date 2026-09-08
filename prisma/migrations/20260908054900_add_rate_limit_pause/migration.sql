-- CreateTable
CREATE TABLE "QueuedPrompt" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "sessionId" TEXT NOT NULL,
    "position" INTEGER NOT NULL,
    "messageId" TEXT NOT NULL,
    "content" TEXT NOT NULL,
    "text" TEXT NOT NULL,
    "attachments" TEXT NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "QueuedPrompt_sessionId_fkey" FOREIGN KEY ("sessionId") REFERENCES "Session" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "RateLimitWindow" (
    "limitType" TEXT NOT NULL PRIMARY KEY,
    "rejected" BOOLEAN NOT NULL,
    "utilization" REAL,
    "resetsAt" DATETIME NOT NULL,
    "observedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- RedefineTables
PRAGMA defer_foreign_keys=ON;
PRAGMA foreign_keys=OFF;
CREATE TABLE "new_GlobalSettings" (
    "id" TEXT NOT NULL PRIMARY KEY DEFAULT 'global',
    "systemPromptOverride" TEXT,
    "systemPromptOverrideEnabled" BOOLEAN NOT NULL DEFAULT false,
    "systemPromptAppend" TEXT,
    "claudeModel" TEXT,
    "advisorModel" TEXT,
    "claudeApiKey" TEXT,
    "ttsSpeed" REAL,
    "voiceAutoSend" BOOLEAN NOT NULL DEFAULT true,
    "settingSourceUser" BOOLEAN NOT NULL DEFAULT false,
    "settingSourceProject" BOOLEAN NOT NULL DEFAULT true,
    "settingSourceLocal" BOOLEAN NOT NULL DEFAULT false,
    "rateLimitPauseEnabled" BOOLEAN NOT NULL DEFAULT false,
    "rateLimitPauseThreshold" INTEGER NOT NULL DEFAULT 95,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);
INSERT INTO "new_GlobalSettings" ("advisorModel", "claudeApiKey", "claudeModel", "createdAt", "id", "settingSourceLocal", "settingSourceProject", "settingSourceUser", "systemPromptAppend", "systemPromptOverride", "systemPromptOverrideEnabled", "ttsSpeed", "updatedAt", "voiceAutoSend") SELECT "advisorModel", "claudeApiKey", "claudeModel", "createdAt", "id", "settingSourceLocal", "settingSourceProject", "settingSourceUser", "systemPromptAppend", "systemPromptOverride", "systemPromptOverrideEnabled", "ttsSpeed", "updatedAt", "voiceAutoSend" FROM "GlobalSettings";
DROP TABLE "GlobalSettings";
ALTER TABLE "new_GlobalSettings" RENAME TO "GlobalSettings";
CREATE TABLE "new_Session" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "name" TEXT NOT NULL,
    "repoUrl" TEXT,
    "branch" TEXT,
    "repoPath" TEXT NOT NULL DEFAULT '',
    "status" TEXT NOT NULL DEFAULT 'creating',
    "statusMessage" TEXT,
    "currentBranch" TEXT,
    "pullRequest" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    "lastActivityAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "messageSequence" INTEGER NOT NULL DEFAULT 0,
    "sessionScope" TEXT,
    "claudeModel" TEXT,
    "rateLimitPauseEnabled" BOOLEAN,
    "rateLimitPauseThreshold" INTEGER,
    "resumeAfterRateLimit" BOOLEAN NOT NULL DEFAULT false,
    "queuedPromptSequence" INTEGER NOT NULL DEFAULT 0
);
INSERT INTO "new_Session" ("branch", "claudeModel", "createdAt", "currentBranch", "id", "lastActivityAt", "messageSequence", "name", "pullRequest", "repoPath", "repoUrl", "sessionScope", "status", "statusMessage", "updatedAt") SELECT "branch", "claudeModel", "createdAt", "currentBranch", "id", "lastActivityAt", "messageSequence", "name", "pullRequest", "repoPath", "repoUrl", "sessionScope", "status", "statusMessage", "updatedAt" FROM "Session";
DROP TABLE "Session";
ALTER TABLE "new_Session" RENAME TO "Session";
CREATE INDEX "Session_status_idx" ON "Session"("status");
CREATE INDEX "Session_status_lastActivityAt_id_idx" ON "Session"("status", "lastActivityAt", "id");
PRAGMA foreign_keys=ON;
PRAGMA defer_foreign_keys=OFF;

-- CreateIndex
CREATE UNIQUE INDEX "QueuedPrompt_sessionId_position_key" ON "QueuedPrompt"("sessionId", "position");
