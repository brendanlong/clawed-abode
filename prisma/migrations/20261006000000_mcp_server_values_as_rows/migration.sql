CREATE TABLE "McpServerValue" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "mcpServerId" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "value" TEXT NOT NULL,
    "isSecret" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "McpServerValue_mcpServerId_fkey" FOREIGN KEY ("mcpServerId") REFERENCES "McpServer" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE UNIQUE INDEX "McpServerValue_mcpServerId_kind_name_key" ON "McpServerValue"("mcpServerId", "kind", "name");

-- Each JSON column was { "NAME": { "value": "...", "isSecret": bool } }; only the
-- one matching the server's type was ever read.
INSERT INTO "McpServerValue" ("id", "mcpServerId", "kind", "name", "value", "isSecret", "createdAt", "updatedAt")
SELECT lower(hex(randomblob(16))), s."id", 'env', e."key",
       json_extract(e."value", '$.value'), coalesce(json_extract(e."value", '$.isSecret'), 0),
       s."updatedAt", s."updatedAt"
FROM "McpServer" s, json_each(s."env") e
WHERE s."type" = 'stdio' AND s."env" IS NOT NULL;

INSERT INTO "McpServerValue" ("id", "mcpServerId", "kind", "name", "value", "isSecret", "createdAt", "updatedAt")
SELECT lower(hex(randomblob(16))), s."id", 'header', h."key",
       json_extract(h."value", '$.value'), coalesce(json_extract(h."value", '$.isSecret'), 0),
       s."updatedAt", s."updatedAt"
FROM "McpServer" s, json_each(s."headers") h
WHERE s."type" <> 'stdio' AND s."headers" IS NOT NULL;

-- DROP COLUMN rather than Prisma's table rebuild, which would lose the
-- hand-written partial unique index McpServer_global_name_key.
ALTER TABLE "McpServer" DROP COLUMN "env";
ALTER TABLE "McpServer" DROP COLUMN "headers";
