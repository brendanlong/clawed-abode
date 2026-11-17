-- Store the repo as "owner/repo" instead of its clone URL, and derive the clone
-- folder from it instead of storing it separately.
ALTER TABLE "Session" RENAME COLUMN "repoUrl" TO "repoFullName";

UPDATE "Session"
SET "repoFullName" = substr("repoFullName", length('https://github.com/') + 1)
WHERE "repoFullName" LIKE 'https://github.com/%';

UPDATE "Session"
SET "repoFullName" = substr("repoFullName", 1, length("repoFullName") - length('.git'))
WHERE "repoFullName" LIKE '%.git';

ALTER TABLE "Session" DROP COLUMN "repoPath";
