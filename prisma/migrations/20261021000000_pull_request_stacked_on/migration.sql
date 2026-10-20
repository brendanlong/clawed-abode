-- Stored PR info gains stackedOn; unknown until the next refresh, which open PRs get within a poll.
UPDATE "PullRequest" SET "info" = json_set("info", '$.stackedOn', json('null')) WHERE json_valid("info");
UPDATE "Session" SET "pullRequest" = json_set("pullRequest", '$.stackedOn', json('null')) WHERE json_valid("pullRequest");
