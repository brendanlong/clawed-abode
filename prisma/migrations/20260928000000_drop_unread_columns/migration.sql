-- AlterTable
ALTER TABLE "McpOAuth" DROP COLUMN "authorizationEndpoint";
ALTER TABLE "McpOAuth" DROP COLUMN "registrationEndpoint";

-- AlterTable
ALTER TABLE "RateLimitWindow" DROP COLUMN "observedAt";
