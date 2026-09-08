-- DropIndex
DROP INDEX "AuthSession_token_idx";

-- DropIndex
DROP INDEX "Message_sessionId_sequence_idx";

-- DropIndex
DROP INDEX "Session_status_idx";

-- CreateIndex
CREATE INDEX "Session_lastActivityAt_id_idx" ON "Session"("lastActivityAt", "id");
