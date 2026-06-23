import { describe, it, expect, vi, beforeEach } from 'vitest';

const mockPrisma = vi.hoisted(() => ({
  session: { count: vi.fn() },
}));
vi.mock('@/lib/prisma', () => ({ prisma: mockPrisma }));

import { reconcileSessions } from './session-reconciler';

describe('session-reconciler service', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('reconcileSessions', () => {
    it('reports 0 when no running sessions exist (no DB mutation)', async () => {
      mockPrisma.session.count.mockResolvedValue(0);
      const result = await reconcileSessions();
      expect(result.runningSessionsToRevive).toBe(0);
      expect(mockPrisma.session.count).toHaveBeenCalledWith({ where: { status: 'running' } });
    });

    it('counts running sessions to be revived lazily', async () => {
      mockPrisma.session.count.mockResolvedValue(3);
      const result = await reconcileSessions();
      expect(result.runningSessionsToRevive).toBe(3);
    });

    it('propagates errors', async () => {
      mockPrisma.session.count.mockRejectedValue(new Error('DB error'));
      await expect(reconcileSessions()).rejects.toThrow('DB error');
    });
  });
});
