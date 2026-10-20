-- AlterTable
ALTER TABLE "PullRequestWatch" ADD COLUMN "number" INTEGER NOT NULL DEFAULT 0;

-- DropIndex
DROP INDEX "PullRequestWatch_sessionId_repoFullName_key";

-- CreateIndex
CREATE UNIQUE INDEX "PullRequestWatch_sessionId_repoFullName_number_key" ON "PullRequestWatch"("sessionId", "repoFullName", "number");
