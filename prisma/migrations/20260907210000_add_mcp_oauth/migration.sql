-- Static-header auth stays the default; "oauth" opts an http/sse server into the
-- flow in src/server/services/mcp-oauth.ts. ADD COLUMN leaves the hand-written
-- partial unique index McpServer_global_name_key in place (SQLite only drops
-- indexes when the table is rebuilt).
ALTER TABLE "McpServer" ADD COLUMN "authType" TEXT NOT NULL DEFAULT 'headers';

CREATE TABLE "McpOAuth" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "mcpServerId" TEXT NOT NULL,
    "issuer" TEXT,
    "authorizationEndpoint" TEXT,
    "tokenEndpoint" TEXT,
    "registrationEndpoint" TEXT,
    "resource" TEXT,
    "scope" TEXT,
    "clientId" TEXT,
    "clientSecret" TEXT,
    "clientIdIsManual" BOOLEAN NOT NULL DEFAULT false,
    "flowState" TEXT,
    "codeVerifier" TEXT,
    "redirectUri" TEXT,
    "flowStartedAt" DATETIME,
    "accessToken" TEXT,
    "refreshToken" TEXT,
    "expiresAt" DATETIME,
    "authorizedAt" DATETIME,
    "lastError" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "McpOAuth_mcpServerId_fkey" FOREIGN KEY ("mcpServerId") REFERENCES "McpServer" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE UNIQUE INDEX "McpOAuth_mcpServerId_key" ON "McpOAuth"("mcpServerId");
CREATE UNIQUE INDEX "McpOAuth_flowState_key" ON "McpOAuth"("flowState");
