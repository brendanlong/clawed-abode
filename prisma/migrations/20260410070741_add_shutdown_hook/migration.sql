-- RedefineTables
PRAGMA defer_foreign_keys=ON;
PRAGMA foreign_keys=OFF;
CREATE TABLE "new_GlobalSettings" (
    "id" TEXT NOT NULL PRIMARY KEY DEFAULT 'global',
    "systemPromptOverride" TEXT,
    "systemPromptOverrideEnabled" BOOLEAN NOT NULL DEFAULT false,
    "systemPromptAppend" TEXT,
    "claudeModel" TEXT,
    "claudeApiKey" TEXT,
    "ttsSpeed" REAL,
    "voiceAutoSend" BOOLEAN NOT NULL DEFAULT true,
    "shutdownHookPrompt" TEXT,
    "shutdownHookEnabled" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);
INSERT INTO "new_GlobalSettings" ("claudeApiKey", "claudeModel", "createdAt", "id", "systemPromptAppend", "systemPromptOverride", "systemPromptOverrideEnabled", "ttsSpeed", "updatedAt", "voiceAutoSend") SELECT "claudeApiKey", "claudeModel", "createdAt", "id", "systemPromptAppend", "systemPromptOverride", "systemPromptOverrideEnabled", "ttsSpeed", "updatedAt", "voiceAutoSend" FROM "GlobalSettings";
DROP TABLE "GlobalSettings";
ALTER TABLE "new_GlobalSettings" RENAME TO "GlobalSettings";
PRAGMA foreign_keys=ON;
PRAGMA defer_foreign_keys=OFF;
