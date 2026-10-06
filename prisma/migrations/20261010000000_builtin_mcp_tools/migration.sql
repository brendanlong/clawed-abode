-- AlterTable
ALTER TABLE "GlobalSettings" ADD COLUMN "builtinToolsEnabled" BOOLEAN NOT NULL DEFAULT true;
ALTER TABLE "GlobalSettings" ADD COLUMN "sessionToolsEnabled" BOOLEAN NOT NULL DEFAULT false;
