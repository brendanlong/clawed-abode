-- AlterTable
ALTER TABLE "McpServer" ADD COLUMN "toolFilter" TEXT CONSTRAINT "McpServer_toolFilter_check" CHECK ("toolFilter" IS NULL OR (CASE WHEN json_valid("toolFilter") THEN json_type("toolFilter") = 'object' ELSE 0 END));
