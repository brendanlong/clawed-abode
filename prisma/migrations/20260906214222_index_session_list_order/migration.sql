-- CreateIndex
CREATE INDEX "Session_status_lastActivityAt_id_idx" ON "Session"("status", "lastActivityAt", "id");
