import { router } from '../trpc';
import { authRouter } from './auth';
import { sessionsRouter } from './sessions';
import { claudeRouter } from './claude';
import { githubRouter } from './github';
import { sseRouter } from './sse';
import { repoSettingsRouter } from './repoSettings';
import { globalSettingsRouter } from './globalSettings';
import { voiceRouter } from './voice';

export const appRouter = router({
  auth: authRouter,
  sessions: sessionsRouter,
  claude: claudeRouter,
  github: githubRouter,
  sse: sseRouter,
  repoSettings: repoSettingsRouter,
  globalSettings: globalSettingsRouter,
  voice: voiceRouter,
});

export type AppRouter = typeof appRouter;
