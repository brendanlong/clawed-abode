-- AlterTable
ALTER TABLE "GlobalSettings" ADD COLUMN "settingSourceUser" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "GlobalSettings" ADD COLUMN "settingSourceProject" BOOLEAN NOT NULL DEFAULT true;
ALTER TABLE "GlobalSettings" ADD COLUMN "settingSourceLocal" BOOLEAN NOT NULL DEFAULT false;
