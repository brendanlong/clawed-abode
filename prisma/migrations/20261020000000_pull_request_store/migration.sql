-- CreateTable
CREATE TABLE "PullRequest" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "repoFullName" TEXT NOT NULL,
    "number" INTEGER NOT NULL,
    "info" TEXT NOT NULL,
    "fetchedAt" DATETIME NOT NULL
);

-- CreateTable
CREATE TABLE "PullRequestWatch" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "sessionId" TEXT NOT NULL,
    "repoFullName" TEXT NOT NULL,
    "baselinedAt" DATETIME,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "PullRequestWatch_sessionId_fkey" FOREIGN KEY ("sessionId") REFERENCES "Session" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "PullRequestWatchEvent" (
    "watchId" TEXT NOT NULL,
    "pullRequestId" TEXT NOT NULL,
    "key" TEXT NOT NULL,

    PRIMARY KEY ("watchId", "pullRequestId", "key"),
    CONSTRAINT "PullRequestWatchEvent_watchId_fkey" FOREIGN KEY ("watchId") REFERENCES "PullRequestWatch" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "PullRequestWatchEvent_pullRequestId_fkey" FOREIGN KEY ("pullRequestId") REFERENCES "PullRequest" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- AlterTable
ALTER TABLE "Session" ADD COLUMN "pullRequestId" TEXT REFERENCES "PullRequest" ("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- Archived sessions are never refreshed, so keep their badges, filled out to the new shape.
UPDATE "Session"
SET "pullRequest" = json_set("pullRequest", '$.headBranch', COALESCE("currentBranch", ''), '$.headSha', '', '$.checks', json('null'))
WHERE "status" = 'archived' AND json_valid("pullRequest");

-- The rest aren't linked to a PullRequest row yet; refetch them on next view.
UPDATE "Session" SET "pullRequest" = NULL, "prCheckedAt" = NULL WHERE "status" != 'archived';

-- CreateIndex
CREATE INDEX "Session_pullRequestId_idx" ON "Session"("pullRequestId");

-- CreateIndex
CREATE UNIQUE INDEX "PullRequest_repoFullName_number_key" ON "PullRequest"("repoFullName", "number");

-- CreateIndex
CREATE UNIQUE INDEX "PullRequestWatch_sessionId_repoFullName_key" ON "PullRequestWatch"("sessionId", "repoFullName");
