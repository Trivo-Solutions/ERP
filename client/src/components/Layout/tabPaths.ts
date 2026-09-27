import { NAV_ITEMS } from './navItems';

/** A tab's location is stored as `pathname + search` (hash is dropped). */
export const splitKey = (key: string) => {
  const q = key.indexOf('?');
  return q === -1 ? { pathname: key, search: '' } : { pathname: key.slice(0, q), search: key.slice(q) };
};

export const toKey = (to: string | { pathname?: string; search?: string }): string => {
  if (typeof to === 'string') return to.split('#')[0];
  return (to.pathname ?? '') + (to.search ?? '');
};

// Every path the sidebar links to, with its label. A page that isn't linked directly (New Tag,
// a detail page, ...) belongs to the nav entry whose path is the longest prefix of its own.
const NAV_ENTRIES: Array<{ path: string; label: string }> = NAV_ITEMS.flatMap((item) =>
  item.path ? [{ path: item.path, label: item.label }] : (item.children ?? []).map((c) => ({ path: c.path, label: c.label })),
);

const matchesNav = (pathname: string, navPath: string) =>
  navPath === '/' ? pathname === '/' : pathname === navPath || pathname.startsWith(navPath + '/');

/** The sidebar entry a location belongs to — what a sidebar click looks for among the open tabs. */
export function ownerOf(pathname: string): string {
  let best = '';
  for (const e of NAV_ENTRIES) {
    if (matchesNav(pathname, e.path) && e.path.length > best.length) best = e.path;
  }
  return best || pathname;
}

// Pages reached from inside another page rather than from the sidebar.
const EXTRA_TITLES: Array<[RegExp, string]> = [
  [/^\/tagging\/tags\/new$/, 'New Tag'],
  [/^\/tagging\/tags\/[^/]+\/edit$/, 'Edit Tag'],
  [/^\/tagging\/transfers\/new$/, 'New Transfer'],
  [/^\/tagging\/receives\/[^/]+$/, 'Receive Transfer'],
  [/^\/sales\/invoices\/new$/, 'New Sale'],
  [/^\/sales\/invoices\/[^/]+\/edit$/, 'Edit Invoice'],
  [/^\/designs\/[^/]+$/, 'Design Detail'],
  [/^\/manufacturing\/jobs\/[^/]+$/, 'Job Card'],
  [/^\/finance\/client-ledger\/[^/]+$/, 'Client Ledger'],
  [/^\/finance\/supplier-ledger\/[^/]+$/, 'Supplier Ledger'],
];

export function titleOf(pathname: string): string {
  const extra = EXTRA_TITLES.find(([re]) => re.test(pathname));
  if (extra) return extra[1];
  const owner = ownerOf(pathname);
  return NAV_ENTRIES.find((e) => e.path === owner)?.label ?? 'Page';
}
