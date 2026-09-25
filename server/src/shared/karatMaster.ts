import { tenantQuery } from './tenantContext';

// Each company's own karat/purity list (C1; company-owned since Phase 1 of full company
// isolation — a company's list is seeded from starterMasters.ts and editable independently).
// karat/metalKarat fields on JewelryTag, PoItem, MetalRate, MemoItem, InvoiceItem stay free-text —
// this is the validation source of truth for those writes, mirroring how stateMaster.ts resolves
// free-text state names. Every lookup is pinned to the caller's companyId.
export async function listActiveKarats(companyId: string) {
  return tenantQuery(companyId, (tx) =>
    tx.karatMaster.findMany({ where: { companyId, isActive: true }, orderBy: { code: 'asc' } })
  );
}

export async function isValidKarat(companyId: string, code: string): Promise<boolean> {
  const match = await tenantQuery(companyId, (tx) =>
    tx.karatMaster.findUnique({ where: { companyId_code: { companyId, code } } })
  );
  return !!match && match.isActive;
}
