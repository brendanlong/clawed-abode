/*
  Warnings:

  - You are about to drop the `ClaudeProcess` table. If the table is not empty, all the data it contains will be lost.

*/
-- AlterTable
ALTER TABLE "Session" ADD COLUMN "agentPort" INTEGER;

-- DropTable
PRAGMA foreign_keys=off;
DROP TABLE "ClaudeProcess";
PRAGMA foreign_keys=on;
