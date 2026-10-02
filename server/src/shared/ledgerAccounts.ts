// Chart-of-accounts codes the automatic (system-posted) journal entries in sales/procurement
// depend on. These specific codes are guaranteed to exist via migration
// 20260825_add_ledger_account_seed (same "seed it in the migration, not just prisma/seed.ts"
// precedent as DEFAULT_HSN_CODE / KaratMaster) — finance.service.ts's full seedChartOfAccounts()
// is a separate, broader superset only run by prisma/seed.ts.
export const LEDGER_ACCOUNT = {
  CASH_IN_HAND: '1101',
  BANK_ACCOUNT: '1102',
  ACCOUNTS_RECEIVABLE: '1200',
  INVENTORY: '1300',
  // Input tax credit — GST paid to suppliers on intake, offsetting the *_PAYABLE accounts below.
  INPUT_CGST: '1401',
  INPUT_SGST: '1402',
  INPUT_IGST: '1403',
  // G2g-7d: RCM self-assessed liability/credit — deliberately separate from the ordinary
  // INPUT_*/*_PAYABLE accounts above (never mixed into them: a liability this company
  // self-assesses, not one the supplier charged). See migration 20261002160000's seed for every
  // existing company; new companies get it from the Starter Package chart.
  RCM_INPUT_TAX_CREDIT: '1404',
  ACCOUNTS_PAYABLE: '2100',
  CGST_PAYABLE: '2201',
  SGST_PAYABLE: '2202',
  IGST_PAYABLE: '2203',
  RCM_TAX_PAYABLE: '2204',
  SALES_REVENUE: '4000',
  COST_OF_GOODS: '5000',
  // Sales round-off: credit when the customer is billed up to the rupee, debit when down.
  ROUND_OFF: '6600',
} as const;

// InvoicePayment.mode is free text (NewSalePage.tsx offers CASH/CARD/UPI/CHEQUE); only CASH hits
// the till, everything else clears through the bank — same two-bucket split the seeded chart of
// accounts actually offers (no per-mode sub-accounts exist yet).
export function cashOrBankAccount(mode: string): string {
  return mode.toUpperCase() === 'CASH' ? LEDGER_ACCOUNT.CASH_IN_HAND : LEDGER_ACCOUNT.BANK_ACCOUNT;
}
