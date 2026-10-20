-- CreateTable
CREATE TABLE "SessionPullRequest" (
    "sessionId" TEXT NOT NULL,
    "pullRequestId" TEXT NOT NULL,

    PRIMARY KEY ("sessionId", "pullRequestId"),
    CONSTRAINT "SessionPullRequest_sessionId_fkey" FOREIGN KEY ("sessionId") REFERENCES "Session" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "SessionPullRequest_pullRequestId_fkey" FOREIGN KEY ("pullRequestId") REFERENCES "PullRequest" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateIndex
CREATE INDEX "SessionPullRequest_pullRequestId_idx" ON "SessionPullRequest"("pullRequestId");

-- Keep the links sessions have today.
INSERT INTO "SessionPullRequest" ("sessionId", "pullRequestId")
SELECT "id", "pullRequestId" FROM "Session" WHERE "pullRequestId" IS NOT NULL;
