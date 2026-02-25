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
    "openaiApiKey" TEXT,
    "ttsSpeed" REAL,
    "voiceAutoSend" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);
INSERT INTO "new_GlobalSettings" ("claudeApiKey", "claudeModel", "createdAt", "id", "openaiApiKey", "systemPromptAppend", "systemPromptOverride", "systemPromptOverrideEnabled", "ttsSpeed", "updatedAt") SELECT "claudeApiKey", "claudeModel", "createdAt", "id", "openaiApiKey", "systemPromptAppend", "systemPromptOverride", "systemPromptOverrideEnabled", "ttsSpeed", "updatedAt" FROM "GlobalSettings";
DROP TABLE "GlobalSettings";
ALTER TABLE "new_GlobalSettings" RENAME TO "GlobalSettings";
PRAGMA foreign_keys=ON;
PRAGMA defer_foreign_keys=OFF;
