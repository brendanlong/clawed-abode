-- Rename worktreePath to workspacePath
ALTER TABLE "Session" RENAME COLUMN "worktreePath" TO "workspacePath";

-- Add statusMessage column for progress tracking
ALTER TABLE "Session" ADD COLUMN "statusMessage" TEXT;
