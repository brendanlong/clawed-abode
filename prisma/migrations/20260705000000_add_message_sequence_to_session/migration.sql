-- AlterTable: per-session monotonic counter for atomic message sequence assignment.
-- Holds the NEXT sequence number to assign. insertMessage reserves a value with a
-- single autocommit `UPDATE ... SET messageSequence = messageSequence + 1 RETURNING`
-- statement, which SQLite serializes on the write lock, so concurrent inserts can
-- never collide on (sessionId, sequence).
ALTER TABLE "Session" ADD COLUMN "messageSequence" INTEGER NOT NULL DEFAULT 0;

-- Backfill existing sessions so the next assigned sequence is MAX(sequence)+1.
UPDATE "Session" SET "messageSequence" = COALESCE(
    (SELECT MAX(m."sequence") + 1 FROM "Message" m WHERE m."sessionId" = "Session"."id"),
    0
);
