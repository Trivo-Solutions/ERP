import { prisma } from '../config/database';

// Client.state / Branch.state / Supplier.state are free text (customer-entered state names, not
// GST codes). Resolves that free text to a 2-digit GST state code by case/whitespace-insensitive
// match against StateMaster.name or .aliases. Returns null on no confident match — callers decide
// the fallback (sales.service.ts treats "unresolved" as inter-state, matching prior behavior).
export async function resolveStateCode(stateText: string | null | undefined): Promise<string | null> {
  const normalized = stateText?.trim().toLowerCase();
  if (!normalized) return null;

  const states = await prisma.stateMaster.findMany({ where: { isActive: true } });
  const match = states.find(
    (s) => s.name.toLowerCase() === normalized || s.aliases.some((a) => a.toLowerCase() === normalized)
  );
  return match?.code ?? null;
}
