-- Revival now resumes only Session.claudeSessionId. Sessions whose CLI ran
-- before that column was recorded never had it set; recover it from the latest
-- stored system/init, which the CLI emits only after writing the transcript
-- (and which carries the post-/clear id, if any).
UPDATE "Session"
SET "claudeSessionId" = (
  SELECT json_extract("Message"."content", '$.session_id')
  FROM "Message"
  WHERE "Message"."sessionId" = "Session"."id"
    AND "Message"."type" = 'system'
    AND json_extract("Message"."content", '$.subtype') = 'init'
  ORDER BY "Message"."sequence" DESC
  LIMIT 1
)
WHERE "claudeSessionId" IS NULL;
