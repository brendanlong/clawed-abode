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

-- AlterTable
--
-- Hand-written. Prisma's SQLite generator emits a full table rebuild
-- (RedefineTables) for these, which works but is needlessly hazardous here:
-- SQLite drops a table's indexes with the table, so the rebuild has to reprint
-- the index set, and a generated file captures whatever that set was the day it
-- was written — a later migration that adds or drops a Session index leaves this
-- one silently reinstating the old set. It also drops a table that Message
-- cascades from, which only stays safe because of the PRAGMA dance around it.
--
-- None of that is needed: SQLite's ADD COLUMN handles a nullable column, and a
-- NOT NULL column with a constant default, which is all six of these. Verified
-- equivalent to the generated rebuild with `prisma migrate dev --create-only`
-- (empty diff). Regenerating this file would quietly reintroduce the rebuild.
ALTER TABLE "Session" ADD COLUMN "rateLimitPauseEnabled" BOOLEAN;
ALTER TABLE "Session" ADD COLUMN "rateLimitPauseThreshold" INTEGER;
ALTER TABLE "Session" ADD COLUMN "resumeAfterRateLimit" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "Session" ADD COLUMN "queuedPromptSequence" INTEGER NOT NULL DEFAULT 0;

-- AlterTable
ALTER TABLE "GlobalSettings" ADD COLUMN "rateLimitPauseEnabled" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "GlobalSettings" ADD COLUMN "rateLimitPauseThreshold" INTEGER NOT NULL DEFAULT 95;

-- CreateIndex
CREATE UNIQUE INDEX "QueuedPrompt_sessionId_position_key" ON "QueuedPrompt"("sessionId", "position");
