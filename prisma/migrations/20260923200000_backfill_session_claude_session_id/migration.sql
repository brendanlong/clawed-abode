-- Revival now resumes only Session.claudeSessionId. Sessions whose CLI ran
-- before that column was recorded never had it set; only the CLI produces
-- assistant messages, so those sessions have a transcript under Session.id.
UPDATE "Session"
SET "claudeSessionId" = "id"
WHERE "claudeSessionId" IS NULL
  AND EXISTS (SELECT 1 FROM "Message" WHERE "Message"."sessionId" = "Session"."id" AND "Message"."type" = 'assistant');
