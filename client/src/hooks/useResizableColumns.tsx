import { useCallback, useEffect, useRef, useState } from 'react';
import { Box } from '@mui/material';

// Drag-to-resize columns for a plain MUI <Table> (the shared DataTable has the same behaviour built in; this is for
// tables that cannot be a DataTable because their rows hold live inputs and sub-rows). Use with `tableLayout: 'fixed'`
// and a <colgroup> of `widths`; put {handle(i)} inside each header cell (the cell needs position: relative).

const MIN_WIDTH = 60;

export function useResizableColumns(initial: number[]) {
  const [widths, setWidths] = useState<number[]>(initial);
  const drag = useRef<{ index: number; startX: number; startWidth: number } | null>(null);

  const onMove = useCallback((e: MouseEvent) => {
    const d = drag.current;
    if (!d) return;
    const next = Math.max(MIN_WIDTH, d.startWidth + e.clientX - d.startX);
    setWidths((w) => w.map((x, i) => (i === d.index ? next : x)));
  }, []);
  const onUp = useCallback(() => {
    drag.current = null;
    document.removeEventListener('mousemove', onMove);
    document.removeEventListener('mouseup', onUp);
    document.body.style.userSelect = '';
  }, [onMove]);
  useEffect(() => onUp, [onUp]); // unmounting mid-drag must not leave listeners behind

  const start = (e: React.MouseEvent, index: number) => {
    e.preventDefault();
    e.stopPropagation();
    drag.current = { index, startX: e.clientX, startWidth: widths[index] };
    document.body.style.userSelect = 'none';
    document.addEventListener('mousemove', onMove);
    document.addEventListener('mouseup', onUp);
  };

  const handle = (index: number) => (
    <Box role="separator" aria-orientation="vertical" aria-label="Resize column" onMouseDown={(e) => start(e, index)}
      sx={{ position: 'absolute', top: 0, right: 0, width: 6, height: '100%', cursor: 'col-resize', '&:hover': { bgcolor: 'primary.light', opacity: 0.5 } }} />
  );

  return { widths, total: widths.reduce((a, b) => a + b, 0), handle };
}
