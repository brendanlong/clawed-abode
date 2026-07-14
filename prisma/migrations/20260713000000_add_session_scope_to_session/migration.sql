-- AlterTable: record the systemd user scope unit name a session's Claude CLI runs
-- in. Set when the query (and thus the scope) is established, cleared on clean
-- teardown. A crash never runs teardown, so any row left with a non-null
-- sessionScope names a scope orphaned by the previous process; the startup reap
-- (reapOrphanedSessionScopes) stops exactly those recorded units — never a glob —
-- so it can only ever touch scopes this deployment created.
ALTER TABLE "Session" ADD COLUMN "sessionScope" TEXT;
