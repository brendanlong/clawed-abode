-- CreateTable
CREATE TABLE "GlobalEnvVar" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "globalSettingsId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "value" TEXT NOT NULL,
    "isSecret" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "GlobalEnvVar_globalSettingsId_fkey" FOREIGN KEY ("globalSettingsId") REFERENCES "GlobalSettings" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "GlobalMcpServer" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "globalSettingsId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "type" TEXT NOT NULL DEFAULT 'stdio',
    "command" TEXT NOT NULL DEFAULT '',
    "args" TEXT,
    "env" TEXT,
    "url" TEXT,
    "headers" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "GlobalMcpServer_globalSettingsId_fkey" FOREIGN KEY ("globalSettingsId") REFERENCES "GlobalSettings" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateIndex
CREATE INDEX "GlobalEnvVar_globalSettingsId_idx" ON "GlobalEnvVar"("globalSettingsId");

-- CreateIndex
CREATE UNIQUE INDEX "GlobalEnvVar_globalSettingsId_name_key" ON "GlobalEnvVar"("globalSettingsId", "name");

-- CreateIndex
CREATE INDEX "GlobalMcpServer_globalSettingsId_idx" ON "GlobalMcpServer"("globalSettingsId");

-- CreateIndex
CREATE UNIQUE INDEX "GlobalMcpServer_globalSettingsId_name_key" ON "GlobalMcpServer"("globalSettingsId", "name");
