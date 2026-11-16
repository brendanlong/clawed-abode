import { prisma } from '@/lib/prisma';

export type OomdReviveClaim = 'revive' | 'left_down' | 'not_running';

/**
 * Claim the one automatic revive a systemd-oomd kill gets per user interaction,
 * storing the notice its agent is told on revival. `left_down` when the session
 * was already revived after a kill since the user last interacted: an agent that
 * keeps redoing work the slice can't hold.
 */
export async function claimOomdRevive(sessionId: string, notice: string): Promise<OomdReviveClaim> {
  // Rows from before the adapter switch hold integer dates, which SQLite sorts
  // below text ones; that only makes a stale row read as "no interaction since".
  const { count } = await prisma.session.updateMany({
    where: {
      id: sessionId,
      status: 'running',
      OR: [{ oomRevivedAt: null }, { oomRevivedAt: { lt: prisma.session.fields.lastActivityAt } }],
    },
    data: { oomRevivedAt: new Date(), restartNotice: notice },
  });
  if (count > 0) return 'revive';
  const session = await prisma.session.findUnique({
    where: { id: sessionId },
    select: { status: true },
  });
  return session?.status === 'running' ? 'left_down' : 'not_running';
}
