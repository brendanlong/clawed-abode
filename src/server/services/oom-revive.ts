import { prisma } from '@/lib/prisma';

/**
 * Claim the one automatic revive a systemd-oomd kill gets per user interaction,
 * storing the notice its agent is told on revival. False when the session was
 * already revived after a kill since the user last interacted (an agent that
 * keeps redoing work the slice can't hold), or is no longer running.
 */
export async function claimOomdRevive(sessionId: string, notice: string): Promise<boolean> {
  const { count } = await prisma.session.updateMany({
    where: {
      id: sessionId,
      status: 'running',
      OR: [{ oomRevivedAt: null }, { oomRevivedAt: { lt: prisma.session.fields.lastActivityAt } }],
    },
    data: { oomRevivedAt: new Date(), restartNotice: notice },
  });
  return count > 0;
}
