-- AlterTable: per-session monotonic counter for atomic message sequence assignment.
-- Holds the NEXT sequence number to assign; incremented in the same transaction as
-- each message insert so concurrent inserts can never collide on (sessionId, sequence).
ALTER TABLE "Session" ADD COLUMN "messageSequence" INTEGER NOT NULL DEFAULT 0;

-- Backfill existing sessions so the next assigned sequence is MAX(sequence)+1.
UPDATE "Session" SET "messageSequence" = COALESCE(
    (SELECT MAX(m."sequence") + 1 FROM "Message" m WHERE m."sessionId" = "Session"."id"),
    0
);
