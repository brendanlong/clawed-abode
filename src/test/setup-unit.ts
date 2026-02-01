/**
 * Setup file for unit tests.
 * Sets required environment variables before tests run.
 */

// Set required env vars for unit tests
process.env.CLAUDE_CODE_OAUTH_TOKEN = 'test-oauth-token-placeholder';
process.env.ENCRYPTION_KEY = 'test-encryption-key-for-unit-tests-32ch';
