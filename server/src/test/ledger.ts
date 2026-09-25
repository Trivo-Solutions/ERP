import { platformPrisma as prisma } from '../config/database'; // tests act as the platform/admin role for fixtures and verification; the code under test uses the runtime client

// Test-only mirror of postJournalEntry's account-balance mutation, run in reverse, so the ledger
// entries F1's system code posts during a test can be undone afterward — Account rows are shared
// across test runs (not reset per-test), so leaving their balances drifted would make later runs'
// absolute-balance assertions meaningless.
export async function cleanupJournalEntries(referenceIds: string[]) {
  if (referenceIds.length === 0) return;
  const entries = await prisma.journalEntry.findMany({
    where: { referenceId: { in: referenceIds } },
    include: { lines: true },
  });
  if (entries.length === 0) return;

  for (const entry of entries) {
    for (const line of entry.lines) {
      const netChange = Number(line.debit) - Number(line.credit);
      await prisma.account.update({ where: { id: line.accountId }, data: { balance: { decrement: netChange } } });
    }
  }
  await prisma.journalEntry.deleteMany({ where: { id: { in: entries.map((e) => e.id) } } });
}

// The posted JournalEntry for one referenceId (a sale, payment, return, or intake), with each
// line's account code attached — what F1 tests assert against.
export async function getJournalEntry(referenceId: string) {
  return prisma.journalEntry.findFirst({
    where: { referenceId },
    include: { lines: { include: { account: { select: { code: true } } } } },
  });
}

export function lineAmount(
  entry: NonNullable<Awaited<ReturnType<typeof getJournalEntry>>>,
  code: string,
) {
  const line = entry.lines.find((l) => l.account.code === code);
  return { debit: Number(line?.debit ?? 0), credit: Number(line?.credit ?? 0) };
}
