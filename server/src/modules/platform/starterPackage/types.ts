// ═══════════════════════════════════════════════════════════════════════════
// TRIVO STARTER PACKAGE — the reusable defaults every newly provisioned company receives.
//
// A Starter Package is a plain, versioned DEFINITION (code, reviewed in PRs) — deliberately not a
// set of database rows and not a "template company". Provisioning COPIES it into brand-new,
// company-owned rows; nothing the package describes is ever shared between companies, and a later
// package version never changes a company that already exists.
//
// What a package may contain is fixed by this type and enforced by validateStarterPackage():
//   STARTER    reusable defaults — roles, chart of accounts, jewellery masters, print templates,
//              generic configuration.
// What it can never contain (there is no field for it, and the validator rejects extras):
//   COMPANY    customers, suppliers, employees, users, memberships, branches, inventory, tags,
//              invoices, payments, ledger entries, stock movements, audit logs, notes, addresses,
//              tax identifiers, hardware device ids, credentials, integrations.
//   PLATFORM   TRIVO-level data owned by nobody (HSN codes, GST state codes).
// ═══════════════════════════════════════════════════════════════════════════

export interface StarterRole {
  name: string;
  displayName: string;
  permissions: string[];
}

export interface StarterAccount {
  code: string;
  name: string;
  type: 'ASSET' | 'LIABILITY' | 'EQUITY' | 'REVENUE' | 'EXPENSE';
  subType?: string;
  isSystem: boolean;
}

export interface StarterKarat { code: string; metalType: 'GOLD' | 'SILVER' | 'PLATINUM'; purity: string }
export interface StarterNamed { code: string; name: string }
export interface StarterSubCategory extends StarterNamed { categoryCode: string }
export interface StarterCollection extends StarterNamed { description?: string }
export interface StarterMaterialCode extends StarterNamed {
  materialType: 'METAL' | 'DIAMOND' | 'STONE';
  karat?: string;
  unit: 'GM' | 'CT' | 'PC';
  description?: string;
}
export interface StarterStockType extends StarterNamed { description?: string }
export interface StarterStoneType extends StarterNamed {
  itemType: 'DIAMOND' | 'STONE' | 'PEARL';
  unit: 'CT' | 'GM';
  description?: string;
}
export interface StarterStoneGrade {
  stoneTypeCode: string;
  shape?: string; color?: string; clarity?: string; cut?: string; quality?: string;
}

export interface StarterTagTemplate {
  name: string; isDefault: boolean; widthMm: number; heightMm: number; gapMm: number;
  layout: { elements: Array<Record<string, unknown>> };
}
export interface StarterEstimateTemplate {
  name: string; isDefault: boolean; widthMm: number; heightMm: number;
  layout: { elements: Array<Record<string, unknown>> };
}

export interface StarterConfigEntry { key: string; value: string; category: 'PRICING' | 'GENERAL' }

export interface StarterPackageDefinition {
  /** Monotonically increasing. A company records the version it received; it never changes on its own. */
  version: number;
  name: string;
  roles: StarterRole[];
  chartOfAccounts: StarterAccount[];
  masters: {
    karats: StarterKarat[];
    designCategories: StarterNamed[];
    productCategories: StarterNamed[];
    subCategories: StarterSubCategory[];
    collections: StarterCollection[];
    materialCodes: StarterMaterialCode[];
    stockTypes: StarterStockType[];
    stoneTypes: StarterStoneType[];
    stoneGrades: StarterStoneGrade[];
  };
  templates: {
    tag: StarterTagTemplate[];
    estimate: StarterEstimateTemplate[];
  };
  config: StarterConfigEntry[];
}
