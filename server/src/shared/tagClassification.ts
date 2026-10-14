// A tag's classification is its (categoryId, subCategoryId) pair — those two ids, resolved through the live
// masters, are the ONLY authority for "what kind of piece is this". `JewelryTag.name` is a legacy free-text
// copy written at save time; it is never refreshed when a master is renamed, so it can contradict the ids
// (e.g. a tag named "MATTU BOWL" whose sub-category is now "3 LEG"). Nothing that prints, filters or reports
// a classification may read it as such. See TAG_CLASSIFICATION_INVESTIGATION.md.

export type MasterRef = { id?: string; name: string; code?: string | null } | null | undefined;

export interface TagClassificationInput {
  name?: string | null;          // legacy stored text — fallback ONLY when no category is on the tag
  category?: MasterRef;
  subCategory?: MasterRef;
}

export interface ResolvedClassification {
  category: { name: string; code: string | null } | null;
  subCategory: { name: string; code: string | null } | null;
  /** Live label for the piece: sub-category name, else category name, else the legacy stored name. */
  displayName: string;
}

const ref = (m: MasterRef) => (m ? { name: m.name, code: m.code ?? null } : null);

export function resolveTagClassification(tag: TagClassificationInput): ResolvedClassification {
  return {
    category: ref(tag.category),
    subCategory: ref(tag.subCategory),
    displayName: tag.subCategory?.name || tag.category?.name || tag.name || '',
  };
}

/** The name a NEW or re-classified tag stores: derived by the server from the validated masters, never from the client. */
export function deriveTagName(category: MasterRef, subCategory: MasterRef, fallback: string): string {
  return subCategory?.name || category?.name || fallback;
}

// ── Print-template diagnostics ───────────────────────────────────────────────

export interface LayoutLikeElement { id: string; type: string; boundField?: string; literalText?: string }

export interface TemplateWarning {
  elementId: string;
  code: 'LITERAL_MATCHES_MASTER' | 'LITERAL_MATCHES_TAG_NAME' | 'LEGACY_NAME_FIELD';
  message: string;
}

const norm = (s: string) => s.trim().replace(/\s+/g, ' ').toLowerCase();

/**
 * Static text on a label that reads like a category / sub-category (its name or code, or the tag's stored
 * name) is a silent way for a label to print a classification the tag does not have — it is the same on every
 * label printed from that template. Reports each such element so the print screen can show it before printing.
 * `masters` is every category + sub-category of the company (names and codes).
 */
export function diagnoseTemplateLiterals(
  elements: LayoutLikeElement[],
  masters: { name: string; code?: string | null }[],
  storedTagName?: string | null,
): TemplateWarning[] {
  const known = new Map<string, string>();
  for (const m of masters) {
    known.set(norm(m.name), m.name);
    if (m.code) known.set(norm(m.code), m.code);
  }
  const out: TemplateWarning[] = [];
  for (const el of elements) {
    if (el.type !== 'text' && el.type !== 'barcode' && el.type !== 'qrcode') continue;
    if (!el.boundField && el.literalText?.trim()) {
      const key = norm(el.literalText);
      const hit = known.get(key);
      if (hit) {
        out.push({
          elementId: el.id, code: 'LITERAL_MATCHES_MASTER',
          message: `Static text "${el.literalText}" matches the category/sub-category "${hit}" — it prints the same on every tag from this template. Bind it to the Category / Sub-category field instead.`,
        });
      } else if (storedTagName && key === norm(storedTagName)) {
        out.push({
          elementId: el.id, code: 'LITERAL_MATCHES_TAG_NAME',
          message: `Static text "${el.literalText}" equals this tag's stored name — it will not follow the tag's classification.`,
        });
      }
    }
    if (el.boundField === 'name') {
      out.push({
        elementId: el.id, code: 'LEGACY_NAME_FIELD',
        message: 'The "name" field prints the live sub-category (else category) name, not the stored tag name. Bind Category / Sub-category fields directly for a precise label.',
      });
    }
  }
  return out;
}
