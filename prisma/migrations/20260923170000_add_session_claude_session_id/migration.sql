-- AlterTable
--
-- Hand-written ADD COLUMN rather than Prisma's SQLite table rebuild, for the
-- reasons spelled out in 20260908054900_add_rate_limit_pause.
ALTER TABLE "Session" ADD COLUMN "claudeSessionId" TEXT;
