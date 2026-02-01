-- CreateTable
CREATE TABLE "GlobalSettings" (
    "id" TEXT NOT NULL PRIMARY KEY DEFAULT 'global',
    "systemPromptOverride" TEXT,
    "systemPromptOverrideEnabled" BOOLEAN NOT NULL DEFAULT false,
    "systemPromptAppend" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);
