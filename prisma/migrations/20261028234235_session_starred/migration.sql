-- AlterTable
ALTER TABLE "Session" ADD COLUMN "starred" BOOLEAN NOT NULL DEFAULT false;

-- DropIndex
DROP INDEX "Session_status_lastActivityAt_id_idx";

-- CreateIndex
CREATE INDEX "Session_starred_lastActivityAt_id_idx" ON "Session"("starred", "lastActivityAt", "id");

-- CreateIndex
CREATE INDEX "Session_status_starred_lastActivityAt_id_idx" ON "Session"("status", "starred", "lastActivityAt", "id");
