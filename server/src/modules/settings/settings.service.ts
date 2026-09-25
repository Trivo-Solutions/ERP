import { tenantQuery } from '../../shared/tenantContext';

// Company-scoped key/value settings. Every read and write is pinned to the caller's own
// companyId (and runs through tenantQuery so the RLS session variable is set too) — one company's
// value for a key is invisible to, and independent of, every other company's.

export async function listConfigs(companyId: string) {
  return tenantQuery(companyId, (tx) =>
    tx.systemConfig.findMany({ where: { companyId }, orderBy: [{ category: 'asc' }, { key: 'asc' }] })
  );
}

export async function upsertConfig(companyId: string, key: string, value: string, category?: string) {
  return tenantQuery(companyId, (tx) =>
    tx.systemConfig.upsert({
      where: { companyId_key: { companyId, key } },
      create: { companyId, key, value, category: category ?? 'GENERAL' },
      update: { value },
    })
  );
}
