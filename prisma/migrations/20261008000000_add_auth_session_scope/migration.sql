-- Hand-written CHECK (see the note in schema.prisma). SQLite allows a CHECK on an
-- added column, so no table rebuild is needed.
ALTER TABLE "AuthSession" ADD COLUMN "scope" TEXT NOT NULL DEFAULT 'full'
    CONSTRAINT "AuthSession_scope_check" CHECK ("scope" IN ('full', 'public_files'));
