// Pure helpers for a DataTable's column layout (order / hidden / widths). No React, no network - so the rules
// ("a saved layout never breaks on a column change", "what counts as unsaved") are unit-testable on their own.

export interface TableLayout {
  order: string[];
  hidden: string[];
  widths: Record<string, number>;
}

export interface LayoutColumn {
  key: string;
  defaultHidden?: boolean;
}

export interface ResolvedLayout {
  order: string[];
  hidden: Set<string>;
  widths: Record<string, number>;
}

const isStringList = (v: unknown): v is string[] => Array.isArray(v) && v.every((k) => typeof k === 'string');

/**
 * Turns a saved layout (or none) into what the table should render with, reconciled against the CURRENT columns:
 * keys that no longer exist are dropped, columns the saved layout never saw are appended at the end, and those that
 * are `defaultHidden` start hidden. A missing / malformed saved layout resolves to the page defaults.
 */
export function resolveLayout(saved: Partial<TableLayout> | null | undefined, columns: LayoutColumn[]): ResolvedLayout {
  const validKeys = columns.map((c) => c.key);
  const storedOrder = saved && isStringList(saved.order) ? saved.order : [];
  const storedHidden = saved && isStringList(saved.hidden) ? saved.hidden : [];
  const storedWidths = saved && saved.widths && typeof saved.widths === 'object' && !Array.isArray(saved.widths) ? saved.widths : {};

  const order = storedOrder.filter((k, i) => validKeys.includes(k) && storedOrder.indexOf(k) === i);
  const missing = validKeys.filter((k) => !order.includes(k));
  const hidden = new Set(storedHidden.filter((k) => validKeys.includes(k)));
  columns.forEach((c) => { if (c.defaultHidden && missing.includes(c.key)) hidden.add(c.key); });
  const widths: Record<string, number> = {};
  validKeys.forEach((k) => {
    const w = (storedWidths as Record<string, unknown>)[k];
    if (typeof w === 'number' && Number.isFinite(w)) widths[k] = w;
  });
  return { order: [...order, ...missing], hidden, widths };
}

/** The page's own defaults - what "Reset" returns to. */
export function defaultLayout(columns: LayoutColumn[]): ResolvedLayout {
  return resolveLayout(null, columns);
}

/** A stable string for a layout: equal layouts give equal strings regardless of Set / key order of hidden / widths. */
export function layoutSignature(l: { order: string[]; hidden: Iterable<string>; widths: Record<string, number> }): string {
  const widths = Object.keys(l.widths).sort().map((k) => [k, Math.round(l.widths[k])]);
  return JSON.stringify([l.order, Array.from(l.hidden).sort(), widths]);
}

/** What gets sent to the server: only keys that exist on the table right now, widths rounded. */
export function toSavedLayout(l: ResolvedLayout, columns: LayoutColumn[]): TableLayout {
  const valid = new Set(columns.map((c) => c.key));
  const widths: Record<string, number> = {};
  Object.keys(l.widths).forEach((k) => { if (valid.has(k)) widths[k] = Math.round(l.widths[k]); });
  return {
    order: l.order.filter((k) => valid.has(k)),
    hidden: Array.from(l.hidden).filter((k) => valid.has(k)),
    widths,
  };
}
