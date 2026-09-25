import { useEffect, useMemo, useRef, useState } from 'react';
import {
  Box, Card, Table, TableHead, TableBody, TableRow, TableCell, Typography,
  IconButton, Popover, TextField, Checkbox, FormControlLabel, Menu, MenuItem,
  Divider, Button, Stack,
} from '@mui/material';
import { FilterList, FilterAltOff } from '@mui/icons-material';

export interface DataTableColumn {
  key: string;
  label: string;
  align?: 'left' | 'right' | 'center';
  render?: (row: any) => React.ReactNode;
  // Value used both for the per-column distinct-value filter list and, absent a `render`, cell
  // display. Defaults to `row[key]`.
  filterValue?: (row: any) => string;
  width?: number;
  // Set false only for a column that must always stay visible (e.g. Actions).
  hideable?: boolean;
  // Set false to omit the filter icon for a column where filtering doesn't make sense (e.g. Actions).
  filterable?: boolean;
}

export interface DataTableProps {
  // Stable, unique-per-table string — used as the localStorage key for the user's column
  // order/visibility layout. Two tables sharing a tableId would clobber each other's layout.
  tableId: string;
  columns: DataTableColumn[];
  rows: any[];
  isLoading: boolean;
  getRowId: (row: any) => string;
  selectedId?: string;
  selectedIds?: Set<string>;
  onRowClick?: (row: any, e: React.MouseEvent) => void;
  emptyLabel: string;
  // Default (true) matches the UI_DESIGN_GUIDE §3 pattern: a wide table gets its own horizontal
  // scroll container instead of clipping. See FilterGrid (MastersPage.tsx) for the prior art.
  scrollable?: boolean;
  // Static row(s) appended after the data rows — e.g. a totals/summary row (Trial Balance, P&L).
  // Not filtered, sorted, or reordered along with data rows. Must be valid <TableRow> markup.
  footer?: React.ReactNode;
}

const STORAGE_PREFIX = 'datatable:';
const DEFAULT_COLUMN_WIDTH = 160;
const MIN_COLUMN_WIDTH = 60;

function loadColumnState(tableId: string, columns: DataTableColumn[]) {
  const validKeys = columns.map((c) => c.key);
  let storedOrder: string[] = [];
  let storedHidden: string[] = [];
  let storedWidths: Record<string, number> = {};
  try {
    const raw = localStorage.getItem(STORAGE_PREFIX + tableId);
    if (raw) {
      const parsed = JSON.parse(raw);
      storedOrder = Array.isArray(parsed.order) ? parsed.order : [];
      storedHidden = Array.isArray(parsed.hidden) ? parsed.hidden : [];
      storedWidths = parsed.widths && typeof parsed.widths === 'object' ? parsed.widths : {};
    }
  } catch {
    // Corrupt/foreign localStorage value — fall back to defaults below.
  }
  // Reconcile against the current columns prop: drop stale keys (removed in a later code
  // change), append any new keys at the end — so a saved layout never breaks on a column change.
  const order = storedOrder.filter((k) => validKeys.includes(k));
  const missing = validKeys.filter((k) => !order.includes(k));
  const hidden = new Set(storedHidden.filter((k) => validKeys.includes(k)));
  const widths: Record<string, number> = {};
  validKeys.forEach((k) => { if (typeof storedWidths[k] === 'number') widths[k] = storedWidths[k]; });
  return { order: [...order, ...missing], hidden, widths };
}

export function DataTable({
  tableId, columns, rows, isLoading, getRowId, selectedId, selectedIds, onRowClick,
  emptyLabel, scrollable = true, footer,
}: DataTableProps) {
  const initial = useMemo(() => loadColumnState(tableId, columns), [tableId]);
  const [columnOrder, setColumnOrder] = useState<string[]>(initial.order);
  const [hiddenColumns, setHiddenColumns] = useState<Set<string>>(initial.hidden);
  const [columnWidths, setColumnWidths] = useState<Record<string, number>>(initial.widths);
  const [dragKey, setDragKey] = useState<string | null>(null);
  const [dragOverKey, setDragOverKey] = useState<string | null>(null);
  const [contextMenu, setContextMenu] = useState<{ x: number; y: number; key: string } | null>(null);
  const tableRef = useRef<HTMLTableElement>(null);

  const [filters, setFilters] = useState<Record<string, Set<string>>>({});
  const [filterPopover, setFilterPopover] = useState<{ key: string; el: HTMLElement } | null>(null);
  const [filterDraft, setFilterDraft] = useState<Set<string>>(new Set());
  const [filterSearch, setFilterSearch] = useState('');

  useEffect(() => {
    try {
      localStorage.setItem(STORAGE_PREFIX + tableId, JSON.stringify({ order: columnOrder, hidden: Array.from(hiddenColumns), widths: columnWidths }));
    } catch {
      // localStorage unavailable (private browsing, quota) — layout just won't persist.
    }
  }, [tableId, columnOrder, hiddenColumns, columnWidths]);

  // If the component unmounts mid-resize (rare — navigating away with the mouse still down),
  // don't leave the document-level listeners attached.
  useEffect(() => () => {
    document.removeEventListener('mousemove', onResizeMove);
    document.removeEventListener('mouseup', onResizeUp);
  }, []);

  const byKey = useMemo(() => new Map(columns.map((c) => [c.key, c])), [columns]);
  const visibleColumns = columnOrder.filter((k) => !hiddenColumns.has(k)).map((k) => byKey.get(k)!).filter(Boolean);

  const cellValue = (c: DataTableColumn, row: any) => c.filterValue ? c.filterValue(row) : String(row[c.key] ?? '');

  // Excel-style cascading filters: a column's distinct-value list is computed from rows that
  // already pass every *other* column's active filter (its own filter is excluded so the list
  // still offers back whatever that column itself currently hides). So filtering Type down to
  // "Wholesale" narrows City's checkbox list to only cities that actually have a wholesale
  // client, the same way Excel's AutoFilter dropdowns narrow each other.
  const distinctValues = useMemo(() => {
    const map: Record<string, string[]> = {};
    columns.forEach((c) => {
      const rowsForColumn = rows.filter((row) => columns.every((other) => {
        if (other.key === c.key) return true;
        const f = filters[other.key];
        if (!f) return true;
        return f.has(cellValue(other, row));
      }));
      const set = new Set<string>();
      rowsForColumn.forEach((row) => set.add(cellValue(c, row)));
      map[c.key] = Array.from(set).sort((a, b) => a.localeCompare(b));
    });
    return map;
  }, [columns, rows, filters]);

  const filteredRows = rows.filter((row) => columns.every((c) => {
    const f = filters[c.key];
    if (!f) return true;
    return f.has(cellValue(c, row));
  }));

  // ── Column reorder (native HTML5 drag-and-drop) ──────────────────────────
  // The dragged key is read from the drag event's own `dataTransfer` payload, not from `dragKey`
  // component state — a `drop` handler's closure is only as fresh as the last completed render,
  // and nothing guarantees a re-render lands between `dragstart` and `drop` (state is the right
  // tool for the visual drag-over highlight, but not for data the drop handler depends on).
  function handleDrop(e: React.DragEvent, targetKey: string) {
    const sourceKey = e.dataTransfer.getData('text/plain') || dragKey;
    setDragKey(null);
    setDragOverKey(null);
    if (!sourceKey || sourceKey === targetKey) return;
    setColumnOrder((order) => {
      const next = order.filter((k) => k !== sourceKey);
      const targetIdx = next.indexOf(targetKey);
      next.splice(targetIdx, 0, sourceKey);
      return next;
    });
  }

  // ── Right-click column menu (show/hide/reset/auto-fit) ───────────────────
  function openContextMenu(e: React.MouseEvent, key: string) {
    e.preventDefault();
    setContextMenu({ x: e.clientX, y: e.clientY, key });
  }
  function toggleHidden(key: string) {
    setHiddenColumns((h) => {
      const next = new Set(h);
      if (next.has(key)) next.delete(key); else next.add(key);
      return next;
    });
  }
  function resetColumns() {
    setColumnOrder(columns.map((c) => c.key));
    setHiddenColumns(new Set());
    setColumnWidths({});
    setContextMenu(null);
  }

  // ── Column resize (drag the handle at a header's right edge) ─────────────
  // Uses document-level listeners rather than React drag events — a resize is a plain mouse
  // drag (no native HTML5 DnD involved), and binding to `document` means the resize keeps
  // tracking correctly even if the cursor moves faster than the pointer stays over the thin
  // handle strip.
  const resizeState = useRef<{ key: string; startX: number; startWidth: number } | null>(null);
  const [resizingKey, setResizingKey] = useState<string | null>(null);

  function startResize(e: React.MouseEvent, key: string, currentWidth: number) {
    e.preventDefault();
    e.stopPropagation();
    resizeState.current = { key, startX: e.clientX, startWidth: currentWidth };
    setResizingKey(key);
    document.addEventListener('mousemove', onResizeMove);
    document.addEventListener('mouseup', onResizeUp);
  }
  function onResizeMove(e: MouseEvent) {
    const rs = resizeState.current;
    if (!rs) return;
    const next = Math.max(MIN_COLUMN_WIDTH, rs.startWidth + (e.clientX - rs.startX));
    setColumnWidths((w) => ({ ...w, [rs.key]: next }));
  }
  function onResizeUp() {
    resizeState.current = null;
    setResizingKey(null);
    document.removeEventListener('mousemove', onResizeMove);
    document.removeEventListener('mouseup', onResizeUp);
  }
  // The stored width is really a relative "weight" — in scrollable mode it's used as a literal
  // pixel width (the table just grows and scrolls), but in non-scrollable mode it's normalized
  // against the sum of every visible column's weight so the row always renders to exactly 100%:
  // resizing one column shrinks the others to compensate instead of ever overflowing the panel.
  function widthOf(c: DataTableColumn) {
    return columnWidths[c.key] ?? c.width ?? DEFAULT_COLUMN_WIDTH;
  }
  const totalWeight = useMemo(() => visibleColumns.reduce((sum, c) => sum + widthOf(c), 0), [visibleColumns, columnWidths]);
  function cellWidth(c: DataTableColumn): string | number {
    return scrollable ? widthOf(c) : `${(widthOf(c) / totalWeight) * 100}%`;
  }

  // ── Auto-fit (double-click a resize handle, or "Auto-fit column(s)" from the right-click
  // menu) — sizes a column to its actual rendered content, the same as double-clicking a column
  // border in Excel. Cloning the real cells (rather than measuring text) means it works for
  // whatever a `render` puts in a cell — a Chip, an icon, colored text — not just plain strings.
  function measureColumnWidth(key: string): number | null {
    if (!tableRef.current) return null;
    const cells = tableRef.current.querySelectorAll<HTMLElement>(`[data-col-key="${CSS.escape(key)}"]`);
    if (cells.length === 0) return null;
    const measurer = document.createElement('div');
    measurer.style.cssText = 'position:absolute; visibility:hidden; top:-9999px; left:-9999px; white-space:nowrap;';
    document.body.appendChild(measurer);
    let max = 0;
    cells.forEach((cell) => {
      const clone = cell.cloneNode(true) as HTMLElement;
      clone.style.width = 'auto';
      clone.style.maxWidth = 'none';
      clone.style.overflow = 'visible';
      measurer.replaceChildren(clone);
      max = Math.max(max, measurer.scrollWidth);
    });
    document.body.removeChild(measurer);
    return Math.max(MIN_COLUMN_WIDTH, max + 24); // + cell padding buffer
  }
  function autoFitColumn(key: string) {
    const width = measureColumnWidth(key);
    if (width != null) setColumnWidths((w) => ({ ...w, [key]: width }));
  }
  function autoFitAllColumns() {
    setColumnWidths((w) => {
      const next = { ...w };
      visibleColumns.forEach((c) => {
        const width = measureColumnWidth(c.key);
        if (width != null) next[c.key] = width;
      });
      return next;
    });
  }

  // ── Per-column Excel-style filter popover ────────────────────────────────
  function openFilter(key: string, el: HTMLElement) {
    setFilterDraft(new Set(filters[key] ?? distinctValues[key]));
    setFilterSearch('');
    setFilterPopover({ key, el });
  }
  function applyFilter() {
    if (!filterPopover) return;
    const key = filterPopover.key;
    const allValues = distinctValues[key] ?? [];
    setFilters((f) => {
      const next = { ...f };
      if (filterDraft.size >= allValues.length) delete next[key]; // everything selected = no filter
      else next[key] = new Set(filterDraft);
      return next;
    });
    setFilterPopover(null);
  }
  function clearFilter() {
    if (!filterPopover) return;
    const key = filterPopover.key;
    setFilters((f) => { const next = { ...f }; delete next[key]; return next; });
    setFilterPopover(null);
  }

  const visibleFilterValues = filterPopover
    ? (distinctValues[filterPopover.key] ?? []).filter((v) => v.toLowerCase().includes(filterSearch.toLowerCase()))
    : [];

  return (
    <Card variant="outlined">
      <Box sx={{ overflowX: scrollable ? 'auto' : 'hidden' }}>
        <Table ref={tableRef} size="small" sx={{ tableLayout: 'fixed', width: scrollable ? undefined : '100%' }}>
          <TableHead>
            <TableRow>
              {visibleColumns.map((c, i) => {
                const isFiltered = !!filters[c.key];
                return (
                  <TableCell
                    key={c.key}
                    data-col-key={c.key}
                    align={c.align}
                    onContextMenu={(e) => openContextMenu(e, c.key)}
                    onDragOver={(e) => { e.preventDefault(); setDragOverKey(c.key); }}
                    onDragLeave={() => setDragOverKey((k) => (k === c.key ? null : k))}
                    onDrop={(e) => handleDrop(e, c.key)}
                    sx={(theme) => ({
                      position: 'relative',
                      width: cellWidth(c),
                      borderRight: i < visibleColumns.length - 1 ? 1 : 0,
                      borderColor: 'divider',
                      // Filter icon stays hidden (and its layout width collapsed to 0, so it
                      // doesn't leave dead space or shrink the label) until the header is
                      // hovered/focused, like a spreadsheet's autofilter chrome — except when
                      // this column already has an active filter, where it stays visible so the
                      // active state isn't hidden.
                      '&:hover .dt-filter-btn, &:focus-within .dt-filter-btn': { opacity: 1, width: 20 },
                      ...(dragOverKey === c.key && dragKey !== c.key && { boxShadow: `inset 3px 0 0 0 ${theme.palette.secondary.main}` }),
                    })}
                  >
                    <Box
                      draggable
                      onDragStart={(e) => { e.dataTransfer.setData('text/plain', c.key); e.dataTransfer.effectAllowed = 'move'; setDragKey(c.key); }}
                      onDragEnd={() => { setDragKey(null); setDragOverKey(null); }}
                      sx={{ display: 'flex', alignItems: 'center', gap: 0.25, cursor: 'grab', userSelect: 'none', pr: 1, overflow: 'hidden' }}
                    >
                      <Typography component="span" noWrap sx={{ fontWeight: 'inherit', fontSize: 'inherit', textTransform: 'inherit', letterSpacing: 'inherit', flex: 1 }}>
                        {c.label}
                      </Typography>
                      {c.filterable !== false && (
                        <IconButton
                          size="small"
                          draggable={false}
                          className="dt-filter-btn"
                          onClick={(e) => { e.stopPropagation(); openFilter(c.key, e.currentTarget); }}
                          sx={{
                            p: 0.25, flexShrink: 0, color: isFiltered ? 'secondary.main' : 'action.active',
                            opacity: isFiltered ? 1 : 0, width: isFiltered ? 20 : 0, minWidth: 0, overflow: 'hidden',
                            transition: 'opacity 0.1s, width 0.15s',
                            '&:focus-visible': { opacity: 1, width: 20 },
                          }}
                        >
                          <FilterList sx={{ fontSize: 14 }} />
                        </IconButton>
                      )}
                    </Box>
                    {/* Resize handle — grab the strip at the column's right edge, like Excel.
                        Double-click it to auto-fit the column to its content, also like Excel.
                        In a non-scrollable table the dragged weight is normalized against every
                        other visible column (see `cellWidth`), so widening one column narrows
                        the rest instead of ever pushing the row past the panel's width. */}
                    <Box
                      onMouseDown={(e) => startResize(e, c.key, widthOf(c))}
                      onDoubleClick={(e) => { e.stopPropagation(); autoFitColumn(c.key); }}
                      onClick={(e) => e.stopPropagation()}
                      sx={(theme) => ({
                        position: 'absolute', top: 0, bottom: 0, right: -3, width: 6,
                        cursor: 'col-resize', zIndex: 1,
                        ...(resizingKey === c.key && { bgcolor: theme.palette.secondary.main }),
                        '&:hover': { bgcolor: theme.palette.secondary.main },
                      })}
                    />
                  </TableCell>
                );
              })}
            </TableRow>
          </TableHead>
          <TableBody>
            {isLoading ? (
              <TableRow><TableCell colSpan={visibleColumns.length} align="center" sx={{ py: 3 }}>Loading...</TableCell></TableRow>
            ) : filteredRows.map((row) => (
              <TableRow key={getRowId(row)} hover
                selected={selectedIds ? selectedIds.has(getRowId(row)) : selectedId === getRowId(row)}
                sx={{ cursor: onRowClick ? 'pointer' : 'default' }}
                onClick={(e) => onRowClick?.(row, e)}>
                {visibleColumns.map((c, i) => (
                  <TableCell key={c.key} data-col-key={c.key} align={c.align}
                    sx={{ width: cellWidth(c), overflow: 'hidden', textOverflow: 'ellipsis', borderRight: i < visibleColumns.length - 1 ? 1 : 0, borderColor: 'divider' }}>
                    {c.render ? c.render(row) : row[c.key] ?? '—'}
                  </TableCell>
                ))}
              </TableRow>
            ))}
            {!isLoading && filteredRows.length === 0 && (
              <TableRow><TableCell colSpan={visibleColumns.length} align="center" sx={{ py: 3 }}>{emptyLabel}</TableCell></TableRow>
            )}
            {footer}
          </TableBody>
        </Table>
      </Box>
      <Box sx={{ px: 1.5, py: 0.75, borderTop: 1, borderColor: 'divider' }}>
        <Typography variant="caption" color="text.secondary">{filteredRows.length} of {rows.length} entries</Typography>
      </Box>

      {/* Right-click column menu: show/hide any column, auto-fit, reset layout */}
      <Menu
        open={!!contextMenu}
        onClose={() => setContextMenu(null)}
        anchorReference="anchorPosition"
        anchorPosition={contextMenu ? { top: contextMenu.y, left: contextMenu.x } : undefined}
      >
        {columns.map((c) => (
          <MenuItem key={c.key} dense onClick={() => c.hideable !== false && toggleHidden(c.key)} disabled={c.hideable === false}>
            <FormControlLabel
              sx={{ mr: 0, pointerEvents: 'none' }}
              control={<Checkbox size="small" checked={!hiddenColumns.has(c.key)} disabled={c.hideable === false} />}
              label={c.label}
            />
          </MenuItem>
        ))}
        <Divider />
        <MenuItem dense onClick={() => { if (contextMenu) autoFitColumn(contextMenu.key); setContextMenu(null); }}>
          Auto-fit "{contextMenu ? byKey.get(contextMenu.key)?.label : ''}"
        </MenuItem>
        <MenuItem dense onClick={() => { autoFitAllColumns(); setContextMenu(null); }}>Auto-fit all columns</MenuItem>
        <Divider />
        <MenuItem dense onClick={resetColumns}>Reset columns</MenuItem>
      </Menu>

      {/* Per-column Excel-style filter: search + checkbox list of distinct values */}
      <Popover
        open={!!filterPopover}
        anchorEl={filterPopover?.el}
        onClose={() => setFilterPopover(null)}
        anchorOrigin={{ vertical: 'bottom', horizontal: 'left' }}
      >
        <Box sx={{ p: 1.5, width: 240 }}>
          <TextField
            size="small" fullWidth placeholder="Search…" value={filterSearch}
            onChange={(e) => setFilterSearch(e.target.value)}
            sx={{ mb: 1 }}
          />
          <FormControlLabel
            sx={{ mb: 0.5 }}
            control={
              <Checkbox size="small"
                checked={visibleFilterValues.length > 0 && visibleFilterValues.every((v) => filterDraft.has(v))}
                indeterminate={visibleFilterValues.some((v) => filterDraft.has(v)) && !visibleFilterValues.every((v) => filterDraft.has(v))}
                onChange={(e) => setFilterDraft((d) => {
                  const next = new Set(d);
                  visibleFilterValues.forEach((v) => e.target.checked ? next.add(v) : next.delete(v));
                  return next;
                })}
              />
            }
            label={<Typography variant="body2" fontWeight={600}>Select All</Typography>}
          />
          <Divider sx={{ mb: 0.5 }} />
          <Box sx={{ maxHeight: 220, overflowY: 'auto' }}>
            {visibleFilterValues.map((v) => (
              <FormControlLabel
                key={v}
                sx={{ display: 'flex', mr: 0 }}
                control={
                  <Checkbox size="small" checked={filterDraft.has(v)}
                    onChange={(e) => setFilterDraft((d) => {
                      const next = new Set(d);
                      e.target.checked ? next.add(v) : next.delete(v);
                      return next;
                    })}
                  />
                }
                label={<Typography variant="body2" noWrap>{v || '(blank)'}</Typography>}
              />
            ))}
          </Box>
          <Stack direction="row" spacing={1} sx={{ mt: 1.5 }}>
            <Button size="small" variant="contained" onClick={applyFilter}>OK</Button>
            <Button size="small" startIcon={<FilterAltOff sx={{ fontSize: 14 }} />} onClick={clearFilter}>Clear</Button>
          </Stack>
        </Box>
      </Popover>
    </Card>
  );
}
