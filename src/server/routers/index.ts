import { router } from '../trpc';
import { authRouter } from './auth';
import { sessionsRouter } from './sessions';
import { claudeRouter } from './claude';
import { githubRouter } from './github';
import { sseRouter } from './sse';
import { repoSettingsRouter } from './repoSettings';
import { globalSettingsRouter } from './globalSettings';
import { rateLimitRouter } from './rateLimit';

export const appRouter = router({
  auth: authRouter,
  sessions: sessionsRouter,
  claude: claudeRouter,
  github: githubRouter,
  sse: sseRouter,
  repoSettings: repoSettingsRouter,
  globalSettings: globalSettingsRouter,
  rateLimit: rateLimitRouter,
});

export type AppRouter = typeof appRouter;
