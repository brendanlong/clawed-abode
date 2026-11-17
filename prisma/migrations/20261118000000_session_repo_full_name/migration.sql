-- Store the repo as "owner/repo" instead of its clone URL, and derive the clone
-- folder from it instead of storing it separately.
ALTER TABLE "Session" RENAME COLUMN "repoUrl" TO "repoFullName";

ALTER TABLE "Session" DROP COLUMN "repoPath";

-- Backfill: https://github.com/{owner}/{repo}[.git] -> {owner}/{repo}. GLOB is
-- case-sensitive (LIKE isn't), and only rows with the prefix are touched.
UPDATE "Session"
SET "repoFullName" = CASE
  WHEN "repoFullName" GLOB '*.git'
    THEN substr("repoFullName", 20, length("repoFullName") - 19 - 4)
  ELSE substr("repoFullName", 20)
END
WHERE "repoFullName" GLOB 'https://github.com/*';
