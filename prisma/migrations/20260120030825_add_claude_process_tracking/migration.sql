-- CreateTable
CREATE TABLE "ClaudeProcess" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "sessionId" TEXT NOT NULL,
    "containerId" TEXT NOT NULL,
    "outputFile" TEXT NOT NULL,
    "lastSequence" INTEGER NOT NULL,
    "startedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "ClaudeProcess_sessionId_fkey" FOREIGN KEY ("sessionId") REFERENCES "Session" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateIndex
CREATE UNIQUE INDEX "ClaudeProcess_sessionId_key" ON "ClaudeProcess"("sessionId");
