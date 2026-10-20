import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import type { Query } from '@anthropic-ai/claude-agent-sdk';
import { setupTestDb, teardownTestDb, testPrisma, clearTestDb } from '@/test/setup-test-db';
import { createTestSession } from '@/test/fixtures';
import { waitFor } from '@/test/wait-for';
import type { RateLimitReading } from '@/lib/rate-limit';
import type { UsagePort } from './usage';

let usage: typeof import('./usage');
let rateLimitState: typeof import('./rate-limit-state');

const HOUR_MS = 60 * 60 * 1000;

const working = new Set<string>();
const liveModels = new Map<string, string>();
const usageCall = vi.fn<() => Promise<unknown>>();
const fakeQuery = {
  usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET: usageCall,
} as unknown as Query;
const port = {
  isSessionWorking: vi.fn((id: string) => working.has(id)),
  deliverMessage: vi.fn(async (_id: string, _text: string) => true),
  liveModel: vi.fn((id: string) => liveModels.get(id)),
  subscriptionQuery: vi.fn((_id: string): Query | null => fakeQuery),
} satisfies UsagePort;

function reading(overrides: Partial<RateLimitReading> = {}): RateLimitReading {
  return {
    limitType: 'five_hour',
    rejected: false,
    authoritative: true,
    utilization: 50,
    resetsAtMs: Math.round((Date.now() + 2 * HOUR_MS) / 1000) * 1000,
    ...overrides,
  };
}

const deliveredTo = () => port.deliverMessage.mock.calls.map(([id]) => id);

describe('usage tools', () => {
  beforeAll(async () => {
    await setupTestDb();
    usage = await import('./usage');
    rateLimitState = await import('./rate-limit-state');
  });

  afterAll(async () => {
    rateLimitState._resetRateLimitState();
    await teardownTestDb();
  });

  beforeEach(async () => {
    await clearTestDb();
    rateLimitState._resetRateLimitState();
    usage._resetUsageState();
    usage.initUsage(port);
    working.clear();
    liveModels.clear();
    vi.clearAllMocks();
    usageCall.mockResolvedValue({ rate_limits_available: false, rate_limits: null });
  });

  describe('alerts', () => {
    it('alerts a working session once its window crosses the threshold, and only once per window', async () => {
      const session = await createTestSession();
      working.add(session.id);
      await usage.setUsageAlerts(session.id, { fiveHour: 80, weekly: null });

      await rateLimitState.recordRateLimitReadings([reading({ utilization: 70 })]);
      await rateLimitState.recordRateLimitReadings([reading({ utilization: 85 })]);
      await waitFor(() => port.deliverMessage.mock.calls.length === 1);
      expect(port.deliverMessage.mock.calls[0][1]).toContain('5-hour limit is 85% used');

      await rateLimitState.recordRateLimitReadings([reading({ utilization: 95 })]);
      await usage.checkUsageAlerts(session.id);
      expect(port.deliverMessage).toHaveBeenCalledTimes(1);
    });

    it('holds an idle session’s alert until it starts working', async () => {
      const session = await createTestSession();
      await usage.setUsageAlerts(session.id, { fiveHour: 80, weekly: null });

      await rateLimitState.recordRateLimitReadings([reading({ utilization: 90 })]);
      await usage.checkUsageAlerts(session.id);
      expect(port.deliverMessage).not.toHaveBeenCalled();

      working.add(session.id);
      await usage.checkUsageAlerts(session.id);
      expect(deliveredTo()).toEqual([session.id]);
    });

    it('drops an alert whose window reset before the session started working', async () => {
      const session = await createTestSession();
      await usage.setUsageAlerts(session.id, { fiveHour: 80, weekly: null });
      await rateLimitState.recordRateLimitReadings([
        reading({ utilization: 90, resetsAtMs: Date.now() + 200 }),
      ]);
      await new Promise((resolve) => setTimeout(resolve, 300));

      working.add(session.id);
      await usage.checkUsageAlerts(session.id);
      expect(port.deliverMessage).not.toHaveBeenCalled();
    });

    it('skips sessions that never opted in, and windows already past the threshold when it was set', async () => {
      const optedOut = await createTestSession();
      const optedIn = await createTestSession();
      working.add(optedOut.id).add(optedIn.id);
      await rateLimitState.recordRateLimitReadings([reading({ utilization: 90 })]);
      await usage.setUsageAlerts(optedIn.id, { fiveHour: 80, weekly: 80 });

      const weekly = reading({
        limitType: 'seven_day',
        utilization: 85,
        resetsAtMs: Date.now() + 100 * HOUR_MS,
      });
      await rateLimitState.recordRateLimitReadings([reading({ utilization: 92 }), weekly]);
      await waitFor(() => port.deliverMessage.mock.calls.length === 1);
      expect(deliveredTo()).toEqual([optedIn.id]);
      expect(port.deliverMessage.mock.calls[0][1]).toContain('weekly limit is 85% used');
      expect(port.deliverMessage.mock.calls[0][1]).not.toContain('5-hour');
    });

    it('holds back an alert from a session the rate-limit pause is holding, even with a background task running', async () => {
      const session = await createTestSession({
        rateLimitPauseEnabled: true,
        rateLimitPauseThreshold: 90,
      });
      working.add(session.id);
      await usage.setUsageAlerts(session.id, { fiveHour: 80, weekly: null });

      await rateLimitState.recordRateLimitReadings([reading({ utilization: 95 })]);
      await usage.checkUsageAlerts(session.id);
      expect(port.deliverMessage).not.toHaveBeenCalled();
    });

    it('does not alert about a crossing that turning alerts on already reported', async () => {
      const session = await createTestSession();
      working.add(session.id);
      usageCall.mockResolvedValue({
        rate_limits: {
          five_hour: {
            utilization: 85,
            resets_at: new Date(Date.now() + 2 * HOUR_MS).toISOString(),
          },
        },
      });

      await usage.setUsageAlerts(session.id, { fiveHour: 80, weekly: null });
      expect(usageCall).toHaveBeenCalledTimes(1);
      await new Promise((resolve) => setTimeout(resolve, 50));
      await usage.checkUsageAlerts(session.id);
      expect(port.deliverMessage).not.toHaveBeenCalled();
    });

    it('persists the thresholds, and turning alerts off stops them', async () => {
      const session = await createTestSession();
      working.add(session.id);
      await usage.setUsageAlerts(session.id, { fiveHour: 50, weekly: 60 });
      expect(
        await testPrisma.session.findUnique({
          where: { id: session.id },
          select: { usageAlertFiveHour: true, usageAlertWeekly: true },
        })
      ).toEqual({ usageAlertFiveHour: 50, usageAlertWeekly: 60 });

      await usage.setUsageAlerts(session.id, { fiveHour: null, weekly: null });
      await rateLimitState.recordRateLimitReadings([reading({ utilization: 99 })]);
      await usage.checkUsageAlerts(session.id);
      expect(port.deliverMessage).not.toHaveBeenCalled();
    });
  });

  describe('report', () => {
    it('refreshes stale readings from the usage snapshot, at most once per staleness period', async () => {
      const session = await createTestSession();
      const resetsAt = new Date(Date.now() + 3 * HOUR_MS).toISOString();
      usageCall.mockResolvedValue({
        rate_limits_available: true,
        rate_limits: {
          five_hour: { utilization: 12.5, resets_at: resetsAt },
          model_scoped: [{ display_name: 'Fable', utilization: 30, resets_at: resetsAt }],
        },
      });

      const report = await usage.getUsageReport(session.id);
      expect(port.subscriptionQuery).toHaveBeenCalledWith(session.id);
      expect(report.windows).toMatchObject([{ limitType: 'five_hour', percentUsed: 13 }]);
      expect(report.modelWindows).toMatchObject([
        { window: 'weekly Fable limit', percentUsed: 30 },
      ]);
      expect(report.asOf).not.toBeNull();

      await usage.getUsageReport(session.id);
      expect(usageCall).toHaveBeenCalledTimes(1);
    });

    it('stops asking for snapshots once one shows the credential can’t see plan limits', async () => {
      const session = await createTestSession();
      await rateLimitState.recordRateLimitReadings([reading({ utilization: 40 })]);
      await usage.getUsageReport(session.id);
      expect(usageCall).toHaveBeenCalledTimes(1);

      vi.useFakeTimers({ toFake: ['Date'] });
      try {
        vi.setSystemTime(Date.now() + 10 * 60 * 1000);
        await rateLimitState.recordRateLimitReadings([reading({ utilization: 41 })]);
        await usage.getUsageReport(session.id);
        expect(usageCall).toHaveBeenCalledTimes(1);
      } finally {
        vi.useRealTimers();
      }
    });

    it('asks for a snapshot while the stream’s readings are fresh, for the per-model windows', async () => {
      const session = await createTestSession();
      await rateLimitState.recordRateLimitReadings([reading({ utilization: 40 })]);
      const report = await usage.getUsageReport(session.id);
      expect(usageCall).toHaveBeenCalledTimes(1);
      expect(report.windows).toMatchObject([{ limitType: 'five_hour', percentUsed: 40 }]);
    });

    it('falls back to the readings it has when the snapshot call fails', async () => {
      const session = await createTestSession();
      usageCall.mockRejectedValue(new Error('unknown control request'));
      const report = await usage.getUsageReport(session.id);
      expect(report.windows).toEqual([]);
      expect(report.asOf).toBeNull();
    });
  });

  describe('session usage bars', () => {
    it('shows the weekly window scoped to the session’s model, from the snapshot', async () => {
      const session = await createTestSession();
      const weekly = reading({
        limitType: 'seven_day',
        utilization: 44,
        resetsAtMs: Date.now() + 100 * HOUR_MS,
      });
      await rateLimitState.recordRateLimitReadings([reading({ utilization: 58 }), weekly]);
      usageCall.mockResolvedValue({
        rate_limits: {
          model_scoped: [
            {
              display_name: 'Fable',
              utilization: 86,
              resets_at: new Date(Date.now() + 100 * HOUR_MS).toISOString(),
            },
          ],
        },
      });

      const fable = await usage.getSessionSubscriptionUsage(session.id, 'claude-fable-5-1');
      expect(fable?.fiveHour?.percentUsed).toBe(58);
      expect(fable?.weeklyModel).toMatchObject({ label: 'Weekly (Fable)', percentUsed: 86 });
      expect(fable?.weeklyAllModels?.percentUsed).toBe(44);

      const other = await usage.getSessionSubscriptionUsage(session.id, 'claude-sonnet-5-5');
      expect(other?.weeklyModel).toBeNull();
      expect(other?.weeklyAllModels).toMatchObject({ label: 'Weekly', percentUsed: 44 });
      expect(usageCall).toHaveBeenCalledTimes(1);

      liveModels.set(session.id, 'fable');
      const live = await usage.getSessionSubscriptionUsage(session.id, 'claude-sonnet-5-5');
      expect(live?.weekly).toMatchObject({ label: 'Weekly (Fable)' });
    });

    it('shows nothing for a session on a proxied model', async () => {
      const session = await createTestSession();
      await rateLimitState.recordRateLimitReadings([reading({ utilization: 58 })]);
      expect(await usage.getSessionSubscriptionUsage(session.id, 'openai/gpt-6')).toBeNull();
    });
  });
});
