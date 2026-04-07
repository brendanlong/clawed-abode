import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock claude-runner
vi.mock('./claude-runner', () => ({
  markAllSessionsStopped: vi.fn().mockResolvedValue(0),
}));

import { reconcileSessions } from './session-reconciler';
import { markAllSessionsStopped } from './claude-runner';

const mockMarkAllSessionsStopped = vi.mocked(markAllSessionsStopped);

describe('session-reconciler service', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('reconcileSessions', () => {
    it('should return 0 when no running sessions exist', async () => {
      mockMarkAllSessionsStopped.mockResolvedValue(0);
      const result = await reconcileSessions();
      expect(result.sessionsMarkedStopped).toBe(0);
      expect(mockMarkAllSessionsStopped).toHaveBeenCalledOnce();
    });

    it('should mark running sessions as stopped', async () => {
      mockMarkAllSessionsStopped.mockResolvedValue(3);
      const result = await reconcileSessions();
      expect(result.sessionsMarkedStopped).toBe(3);
    });

    it('should propagate errors', async () => {
      mockMarkAllSessionsStopped.mockRejectedValue(new Error('DB error'));
      await expect(reconcileSessions()).rejects.toThrow('DB error');
    });
  });
});
