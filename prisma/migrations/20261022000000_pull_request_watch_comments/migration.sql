-- Watches now report comments made after baselinedAt; existing ones start from now
-- rather than replaying everything since they were created.
UPDATE "PullRequestWatch" SET "baselinedAt" = strftime('%Y-%m-%dT%H:%M:%f+00:00', 'now')
WHERE "baselinedAt" IS NOT NULL;
