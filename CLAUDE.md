# Coding rules

- Always use types and avoid the 'any' type
- Always validate inputs using libraries like Zod
- Always factor out shared logic
- Don't maintain backwards compatibility, always delete code we're not using
- Read the design doc and keep it up-to-date @doc/DESIGN.md and @doc/architecture.d2
- Avoid N+1 queries, and check-then-set patterns; prefer to do joins or inserts with on conflict
- Design as much code as possible to be unit-testable with pure functions
- Prefer to use real versions of necessary systems for integration tests (i.e. actually run git in a tmp dir, actually run SQLite on an in-memory DB)
- Co-locate test files with source (e.g., `auth.ts` → `auth.test.ts`, or `git.ts` → `git.integration.test.ts` for integration tests). Component/DOM tests use `*.test.tsx` and run under a separate config
- Run `pnpm test:run` to verify tests pass before committing — it runs all suites (unit `*.test.ts`, component `*.test.tsx`, and integration `*.integration.test.ts`), matching what CI checks. Run an individual suite with `pnpm test:unit` / `pnpm test:component` / `pnpm test:integration`
- Try to do work in commit-sized chunks and commit when each piece is complete
- Always commit changes when work is complete
- Always use cursor-based pagination and never offset
- Use pnpm instead of npm
- Always use shadcn/ui components
- Use the centralized logger (`createLogger` from `@/lib/logger`) for all backend logging, especially errors
- When writing tests, don't mock components where the real version is easy to run (like SQLite in-memory)
- Always write tests for the intended behavior of functions, not the actual behavior. If the actual behavior is wrong and the issue is pre-existing, write the test correctly, mark it skipped, and file a GitHub issue on brendanlong/clawed-abode
- Always import at the top of files, not in the middle of functions
- Never use barrel files (index.ts that re-export from other modules). Import directly from the source file instead.

# Documentation rules

Docs explain **why** and **where**; the code explains **how**. The exceptions are patterns agents must follow going forward, and decisions ("we use X", "never do Y — it caused Z"). Reviewers should flag doc bloat and repetition like any other defect.

- Say each thing once, in the one doc where it belongs, as briefly as possible. Don't restate what's easy to read from the code (API signatures, file trees, obvious behavior) — link to the source file instead.
- Don't document history unless it still matters (a past incident that motivates a current rule does; "this used to work differently" doesn't). Don't document non-decisions: something we deferred or haven't built yet is not a commitment and doesn't belong in the docs.
- Structure: this file holds repo-wide rules; per-directory `CLAUDE.md` files hold must-know info for that directory (auto-loaded — never repeat higher-level content); `doc/DESIGN.md` is a short high-level map (auto-loaded into every session, so keep it short); `doc/*.md` are detailed reference docs loaded on demand.
- When changing behavior, update the doc that covers it in the same commit.
