import type { StarterPackageDefinition } from './types';

// The validator is what makes "a Starter Package never carries company data" a mechanical fact
// rather than a convention: every section has an explicit allow-list of keys, so a stray
// `companyId`, `id`, `createdAt`, customer field or device id is rejected, not silently copied.

const TOP_LEVEL = ['version', 'name', 'roles', 'chartOfAccounts', 'masters', 'templates', 'config'];
const MASTER_SECTIONS = [
  'karats', 'designCategories', 'productCategories', 'subCategories', 'collections',
  'materialCodes', 'stockTypes', 'stoneTypes', 'stoneGrades',
];

const ITEM_KEYS: Record<string, string[]> = {
  roles: ['name', 'displayName', 'permissions'],
  chartOfAccounts: ['code', 'name', 'type', 'subType', 'isSystem'],
  karats: ['code', 'metalType', 'purity'],
  designCategories: ['code', 'name'],
  productCategories: ['code', 'name'],
  subCategories: ['code', 'name', 'categoryCode'],
  collections: ['code', 'name', 'description'],
  materialCodes: ['code', 'name', 'materialType', 'karat', 'unit', 'description'],
  stockTypes: ['code', 'name', 'description'],
  stoneTypes: ['code', 'name', 'itemType', 'unit', 'description'],
  stoneGrades: ['stoneTypeCode', 'shape', 'color', 'clarity', 'cut', 'quality'],
  tag: ['name', 'isDefault', 'widthMm', 'heightMm', 'gapMm', 'layout'],
  estimate: ['name', 'isDefault', 'widthMm', 'heightMm', 'layout'],
  config: ['key', 'value', 'category'],
};

// Configuration that describes a specific company's equipment, integrations, identity or
// credentials can never be a "TRIVO default". Rejected by KEY pattern and by CATEGORY.
const FORBIDDEN_CONFIG_KEY = /DEVICE|SCALE|PORT|KEY|TOKEN|SECRET|PASSWORD|CREDENTIAL|URL|HOST|PATH|EMAIL|PHONE|ADDRESS|GSTIN|PAN\b|ACCOUNT_?NO|IFSC|UPI|CENTER|CENTRE|WEBHOOK|SMTP/;
const ALLOWED_CONFIG_CATEGORIES = ['PRICING', 'GENERAL'];

// A print template may only carry generic labels: no e-mail addresses, no phone-like digit runs.
function scanLayoutForCompanyData(value: unknown, path: string, errors: string[]) {
  if (typeof value === 'string') {
    if (/@/.test(value)) errors.push(`${path}: contains '@' (looks like an e-mail address)`);
    if (/\d{7,}/.test(value.replace(/[\s-]/g, ''))) errors.push(`${path}: contains a long digit run (looks like a phone/registration number)`);
  } else if (Array.isArray(value)) {
    value.forEach((v, i) => scanLayoutForCompanyData(v, `${path}[${i}]`, errors));
  } else if (value && typeof value === 'object') {
    for (const [k, v] of Object.entries(value)) scanLayoutForCompanyData(v, `${path}.${k}`, errors);
  }
}

function checkItems(section: string, items: unknown, keyPool: string, errors: string[], uniqueBy?: string[]) {
  if (!Array.isArray(items)) { errors.push(`${section}: must be an array`); return; }
  const allowed = ITEM_KEYS[keyPool];
  const seen = new Set<string>();
  items.forEach((item, i) => {
    if (!item || typeof item !== 'object') { errors.push(`${section}[${i}]: must be an object`); return; }
    for (const k of Object.keys(item)) {
      if (!allowed.includes(k)) errors.push(`${section}[${i}]: unexpected field '${k}' — a Starter Package carries only ${allowed.join(', ')}`);
    }
    if (uniqueBy) {
      const key = uniqueBy.map((f) => String((item as Record<string, unknown>)[f] ?? '')).join('|');
      if (seen.has(key)) errors.push(`${section}[${i}]: duplicate ${uniqueBy.join('+')} '${key}'`);
      seen.add(key);
    }
  });
}

/** Returns every problem found (empty array = valid). Never throws. */
export function collectStarterPackageErrors(pkg: StarterPackageDefinition): string[] {
  const errors: string[] = [];
  const p = pkg as unknown as Record<string, unknown>;

  for (const k of Object.keys(p)) if (!TOP_LEVEL.includes(k)) errors.push(`unexpected top-level field '${k}'`);
  if (!Number.isInteger(pkg.version) || pkg.version < 1) errors.push('version must be a positive integer');
  if (!pkg.name) errors.push('name is required');

  checkItems('roles', pkg.roles, 'roles', errors, ['name']);
  for (const r of pkg.roles ?? []) {
    for (const perm of r.permissions ?? []) {
      // J4: action segment may now contain underscore-joined words (report:financial_view,
      // po:approve_high_value) — still exactly one `resource:action` colon, letters only otherwise.
      if (!/^(\*|[A-Za-z]+:[A-Za-z]+(_[A-Za-z]+)*)$/.test(perm)) errors.push(`roles.${r.name}: malformed permission '${perm}'`);
    }
  }
  checkItems('chartOfAccounts', pkg.chartOfAccounts, 'chartOfAccounts', errors, ['code']);

  const masters = (p.masters ?? {}) as Record<string, unknown>;
  for (const k of Object.keys(masters)) if (!MASTER_SECTIONS.includes(k)) errors.push(`masters: unexpected section '${k}'`);
  for (const s of MASTER_SECTIONS) {
    checkItems(`masters.${s}`, masters[s], s, errors, s === 'stoneGrades' ? undefined : ['code']);
  }

  // References must resolve inside the package itself.
  const catCodes = new Set((pkg.masters?.productCategories ?? []).map((c) => c.code));
  for (const sc of pkg.masters?.subCategories ?? []) {
    if (!catCodes.has(sc.categoryCode)) errors.push(`masters.subCategories.${sc.code}: unknown categoryCode '${sc.categoryCode}'`);
  }
  const stoneCodes = new Set((pkg.masters?.stoneTypes ?? []).map((c) => c.code));
  for (const g of pkg.masters?.stoneGrades ?? []) {
    if (!stoneCodes.has(g.stoneTypeCode)) errors.push(`masters.stoneGrades: unknown stoneTypeCode '${g.stoneTypeCode}'`);
  }

  const templates = (p.templates ?? {}) as Record<string, unknown>;
  for (const k of Object.keys(templates)) if (!['tag', 'estimate'].includes(k)) errors.push(`templates: unexpected section '${k}'`);
  checkItems('templates.tag', templates.tag, 'tag', errors, ['name']);
  checkItems('templates.estimate', templates.estimate, 'estimate', errors, ['name']);
  for (const kind of ['tag', 'estimate'] as const) {
    const list = ((templates[kind] as Array<{ isDefault: boolean; name: string; layout: unknown }>) ?? []);
    if (list.filter((t) => t.isDefault).length > 1) errors.push(`templates.${kind}: more than one default`);
    list.forEach((t, i) => scanLayoutForCompanyData(t.layout, `templates.${kind}[${i}].layout`, errors));
  }

  checkItems('config', pkg.config, 'config', errors, ['key']);
  for (const c of pkg.config ?? []) {
    if (!/^[A-Z][A-Z0-9_]*$/.test(c.key)) errors.push(`config.${c.key}: key must be UPPER_SNAKE_CASE`);
    if (FORBIDDEN_CONFIG_KEY.test(c.key)) errors.push(`config.${c.key}: describes company-specific equipment/identity/credentials — not a TRIVO default`);
    if (!ALLOWED_CONFIG_CATEGORIES.includes(c.category)) errors.push(`config.${c.key}: category '${c.category}' is not an allowed starter category (${ALLOWED_CONFIG_CATEGORIES.join(', ')})`);
  }
  return errors;
}

export function validateStarterPackage(pkg: StarterPackageDefinition): void {
  const errors = collectStarterPackageErrors(pkg);
  if (errors.length > 0) {
    throw new Error(`Invalid Starter Package v${pkg?.version}:\n  - ${errors.join('\n  - ')}`);
  }
}
