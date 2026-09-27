# UI Design Guide — Jewellery ERP

> Read this before building or reworking any screen in `client/`. It captures layout conventions
> that were fixed ad hoc across the Tagging and Masters screens; apply them by default on new
> work instead of rediscovering the same problems (fields stacked one-per-row wasting vertical
> space, tables clipped at the viewport edge, dropdowns that trap keyboard users).

## 1. Keyboard-first fields (see also CLAUDE.md §10)

Every dropdown must be changeable while focused, without opening it first — arrow keys and
type-ahead move the value directly, like a native `<select>`. In MUI this means:

```tsx
<TextField select fullWidth label="Category" SelectProps={{ native: true }}
  InputLabelProps={{ shrink: true }}>
  <option value="">None</option>
  {items.map((i) => <option key={i.id} value={i.id}>{i.name}</option>)}
</TextField>
```

- **`SelectProps={{ native: true }}`** — renders a real `<select>`/`<option>` tree instead of
  MUI's menu-based `Select`. This is what gives arrow-key/type-ahead-without-opening for free;
  MUI's own `MenuItem`-based Select does not behave this way.
- **`InputLabelProps={{ shrink: true }}`** is *required* alongside `native: true` — without it the
  label doesn't float above the box and visually overlaps the selected value or the empty
  placeholder. This bit us once (see git history on `NewTagPage.tsx`) — always pair the two.
- `<optgroup label="...">` works fine inside a native select if you need to group options (e.g.
  "Materials" vs "Stones" in `NewTagPage.tsx`) — type-ahead still searches across all groups.
- A searchable *large* list (hundreds of options) still wants a native select over
  MUI's `Autocomplete` for this app — put a short, typeable **code** at the *start* of the option
  label instead of relying on Autocomplete's free-text filtering (see §3). Type-ahead on a native
  select matches from the start of the visible text, so a code-first label makes it just as fast
  to reach as a free-text search box, without giving up the "no popup to open" behavior.

For a spreadsheet-style row of inputs (e.g. a line-items table), Tab/Enter off the last cell of
the last row should append a new row and focus its first cell — see `NewTagPage.tsx`'s
`handleCellKeyDown`/`addRowAndFocus` for the reference implementation (ref-map keyed by
`${rowIndex}-${colIndex}`, `getValues()` for reads inside the handler — not `watch()`, see §4).

## 2. Compact master-detail forms: grid, not stack

An admin master screen (add/edit panel + a list table) used to stack every field in the add/edit
panel one-per-row in a vertical `Stack`. With 5-6 fields that panel became taller than the table
next to it, and the table — the part the user actually scans — got squeezed into whatever space
was left over.

**Default a form panel to a responsive CSS grid**, not a vertical stack:

```tsx
<Box sx={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(160px, 1fr))', gap: 1.5 }}>
  {/* each field is a direct child — no need to wrap fields individually, and a
      React.Fragment child (e.g. a conditionally-rendered block of fields) still lays out
      correctly since Fragments don't add a DOM wrapper */}
</Box>
```

- `auto-fit` + `minmax(160px, 1fr)` means: as many columns fit as the panel is wide (usually
  2-3), each at least 160px, and they reflow automatically on narrower screens — no manual
  breakpoint juggling per screen.
- A field that needs the full row (a multiline/description textarea, or anything long) opts out
  per-field with `sx={{ gridColumn: '1 / -1' }}` — don't make the whole panel single-column just
  to accommodate one wide field.
- See `FormPanel` in `client/src/pages/Masters/MastersPage.tsx` for the canonical
  implementation — it's shared by every Masters tab (Categories, Collections, Material Codes,
  Stone Types, Price Master, Making Charges, Branches), so fixing it there fixed all of them at
  once. Reuse `FormPanel`/`GenericMasterSection` for any *new* simple code/name/type master
  rather than hand-rolling another add/edit panel.

## 3. Tables: `DataTable`, Excel-style by default

**Every new table uses `DataTable`** (`client/src/components/common/DataTable.tsx`), not a bare
`<Table>` and not a hand-rolled filter grid. It's a thin build on plain MUI primitives (no paid
grid library — see its file header) that gives every table, by construction:

- **Full cell gridlines** — every cell boxed on all sides, not just row-separator lines.
- **Excel-style per-column filters** — a filter icon on each header opens a popover: search box
  + "Select All" + a checkbox per distinct value in that column. Click the filter icon (filled
  when a filter is active) rather than typing into a filter row.
- **Drag-to-reorder columns** — grab a header (the label area) and drop it in a new position.
- **Right-click column menu** — right-click any header for a checklist of every column (show/hide)
  plus "Reset columns". A column can opt out of being hidden (`hideable: false`, e.g. an Actions
  column) or out of filtering (`filterable: false`).
- **Optional columns** — a column marked `defaultHidden: true` starts hidden and is switched on from the right-click column menu — use it for the long tail of
  "nice to have" fields (Sales Invoices has ~25 of them) so the default view stays uncluttered.
- **Persisted layout** — column order/visibility is saved to `localStorage` per `tableId`, so a
  user's rearrangement survives a reload. **`tableId` must be a stable, unique-per-table string**
  — two tables sharing one `tableId` will clobber each other's saved layout.

```tsx
<DataTable
  tableId="orders-clients"
  columns={[
    { key: 'code', label: 'Code' },
    { key: 'balance', label: 'Balance', align: 'right', render: (r) => fmtCurrency(r.currentBalance) },
    { key: 'actions', label: 'Actions', hideable: false, filterable: false, render: (r) => <RowActions row={r} /> },
  ]}
  rows={rows} isLoading={isLoading} getRowId={(r) => r.id} emptyLabel="No rows yet"
/>
```

Still wrap it in a scroll container per the original horizontal-scroll rule below if the page
doesn't already rely on `DataTable`'s own `scrollable` (default `true`, same mechanism):

```tsx
<Card variant="outlined">
  <Box sx={{ overflowX: 'auto' }}>...</Box>
</Card>
```

— `DataTable` already does this internally, so you don't need to wrap it again.

A totals/summary row (Trial Balance, P&L) that shouldn't be filtered or reordered along with data
rows goes in the `footer` prop (raw `<TableRow>` markup, appended after the data rows).

`FilterGrid` (`MastersPage.tsx`) is now a thin wrapper over `DataTable` — it still exists and
still works for its ~9 existing Masters-tab call sites, but reach for `DataTable` directly on any
new table rather than adding a new `FilterGrid` call site.

Before reaching for more columns or a wider scroll area, still check whether the column count is
actually justified — `DataTable`'s show/hide menu is a real escape hatch now, but a page that's
already too wide because of redundant columns should still fix that at the source. The Stone
Grades table used to show Shape/Color/Clarity/Cut/Quality as five separate columns — once a
derived **Code** column existed that already read as `DIA-RD-VVS2-G`, four of those five columns
were repeating information the code already carried, and dropping them (down to Code + Cut +
Status) fixed the overflow more robustly than any amount of column-width tuning would have. When
a table is too wide, look for a compact derived/composite column before leaning on scroll or
hide-by-default columns to paper over it.

## 3a. Shared form fields: `SelectField` / `DateField` / `NumberField` / `CurrencyField`

New form fields use the wrappers in `client/src/components/fields/` instead of hand-rolling
`<TextField>` again — they package conventions that used to depend on every author remembering
them:

- **`SelectField`** — packages §1's keyboard-first native-select pattern
  (`SelectProps={{native:true}}` + `InputLabelProps={{shrink:true}}`) so a new dropdown gets
  arrow-key/type-ahead-without-opening by construction. Takes `options`/`optgroups` instead of
  hand-written `<option>` children (though children still work if you need something custom).
- **`DateField`** — the app's existing native `<input type="date">` convention with
  `InputLabelProps={{shrink:true}}` built in. Deliberately not MUI's `DatePicker` — see the
  file's header comment for why.
- **`NumberField`** — a plain numeric input with the native spinner arrows and
  scroll-changes-value browser behavior disabled (a hover-scroll silently bumping a price/weight
  is surprising in a form).
- **`CurrencyField`** — `NumberField` plus a `₹` `InputAdornment` (override via `currencySymbol`).

All four are thin `TextField` wrappers, so they drop straight into the existing
react-hook-form pattern with no other change:

```tsx
<Controller name="creditLimit" control={control}
  render={({ field }) => <CurrencyField {...field} label="Credit Limit" />} />
```

## 3b. Dark mode

`client/src/theme/index.ts` exports both `theme` (light) and `darkTheme`. `main.tsx` wraps the
app in `ThemeModeProvider` (`client/src/theme/ThemeModeProvider.tsx`), which reads
`useUiStore()`'s persisted `darkMode` flag and picks the theme accordingly — toggled from the
`AppShell` AppBar's dark/light-mode icon button, which calls `useUiStore().toggleDarkMode()`.
Don't read/write `darkMode` any other way; go through the store's `toggleDarkMode` action.

Because both themes share one palette definition, **avoid hardcoding hex colors in `sx`** (e.g.
`color: '#44C47A'`) — reference theme tokens instead (`color: 'secondary.main'`,
`theme.palette.secondary.main` inside an `sx` callback) so the color is correct in both themes
and stays in sync if the palette ever changes.

## 4. Live values inside a handler: `getValues()`, not `watch()`

Inside a callback that runs synchronously after changing a react-hook-form field (an `onChange`,
or a helper called from one), read the **current** value with `getValues()`, not a `row`/`value`
captured from `watch()` in the enclosing render. `watch()`'s snapshot is whatever it was when
*that render's* JSX was created — one keystroke behind by the time an `onChange` handler from
that same render actually fires. `getValues()` reads react-hook-form's live internal store, which
`field.onChange()` has already updated synchronously by the time your handler runs. This exact
bug (`recomputeRow` in `NewTagPage.tsx` computing off the value *before* the keystroke that
triggered it) shipped once — don't reintroduce it.

## 5. Where this has already been applied

Treat these as reference implementations, not just prior fixes:

- `client/src/pages/Tagging/NewTagPage.tsx` — native-select keyboard-first fields, spreadsheet
  row entry with Tab/Enter row-advance, `getValues()` inside onChange handlers.
- `client/src/pages/Masters/MastersPage.tsx` — `FormPanel` (grid layout), `FilterGrid`
  (now a `DataTable` wrapper), Stone Grades' derived Code column.
- `client/src/pages/Orders/Clients.tsx` — `DataTable` for the client list (filters, gridlines,
  reorder, right-click column menu) plus `SelectField`/`DateField`/`CurrencyField` in the
  Add-Client and Record-Payment dialogs. The reference to copy from for migrating any other page.
- `client/src/components/common/DataTable.tsx` — the table component itself (§3).
- `client/src/components/fields/` — `SelectField`/`DateField`/`NumberField`/`CurrencyField` (§3a).
- `client/src/theme/ThemeModeProvider.tsx` — dark-mode wiring (§3b).
- `client/src/utils/stoneGrade.ts` — a derived/composite identifier computed from a row's fields
  rather than stored redundantly; reuse this pattern (compute a display key from source fields,
  don't add a column for it) when the same need comes up elsewhere.
