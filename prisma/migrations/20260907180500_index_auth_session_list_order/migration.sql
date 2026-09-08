-- CreateIndex
CREATE INDEX "AuthSession_revokedAt_idx" ON "AuthSession"("revokedAt");

-- CreateIndex
CREATE INDEX "AuthSession_createdAt_id_idx" ON "AuthSession"("createdAt", "id");
