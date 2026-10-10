import { Box, IconButton, Typography } from '@mui/material';
import { Close } from '@mui/icons-material';
import { useTabsStore } from '../../store/tabs.store';
import { splitKey, titleOf } from './tabPaths';
import { useTabActions } from './useTabActions';

export function TabBar() {
  const tabs = useTabsStore((s) => s.tabs);
  const activeId = useTabsStore((s) => s.activeId);
  const { switchTo, closeTab } = useTabActions();

  if (tabs.length === 0) return null;

  return (
    <Box
      role="tablist"
      aria-label="Open pages"
      sx={{
        display: 'flex', alignItems: 'flex-end', gap: 0.5, px: { xs: 0.5, md: 1.5 }, pt: 0.25,
        overflowX: 'auto', scrollbarWidth: 'thin', bgcolor: 'action.hover',
        borderTop: '1px solid', borderColor: 'divider',
      }}
    >
      {tabs.map((tab) => {
        const active = tab.id === activeId;
        const title = titleOf(splitKey(tab.key).pathname);
        return (
          <Box
            key={tab.id}
            role="tab"
            aria-selected={active}
            tabIndex={0}
            title={title}
            onClick={() => switchTo(tab.id)}
            onAuxClick={(e) => { if (e.button === 1) { e.preventDefault(); closeTab(tab.id); } }}
            onMouseDown={(e) => { if (e.button === 1) e.preventDefault(); }} // no autoscroll cursor on middle-click
            onKeyDown={(e) => {
              if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); switchTo(tab.id); }
              else if (e.key === 'Delete') { e.preventDefault(); closeTab(tab.id); }
            }}
            sx={{
              display: 'flex', alignItems: 'center', gap: 0.5, pl: 1.25, pr: 0.25, height: { xs: 34, md: 27 },
              flexShrink: 0, maxWidth: { xs: 150, md: 200 }, cursor: 'pointer', userSelect: 'none',
              borderRadius: '5px 5px 0 0',
              bgcolor: active ? 'background.paper' : 'transparent',
              borderTop: '2px solid', borderTopColor: active ? 'primary.main' : 'transparent',
              color: active ? 'text.primary' : 'text.secondary',
              '&:hover': { bgcolor: active ? 'background.paper' : 'action.selected' },
              '&:focus-visible': { outline: '2px solid', outlineColor: 'primary.main', outlineOffset: -2 },
            }}
          >
            <Typography noWrap sx={{ fontSize: 12, fontWeight: active ? 700 : 500, lineHeight: 1.2 }}>{title}</Typography>
            <IconButton
              size="small"
              tabIndex={-1}
              aria-label={`Close ${title}`}
              onClick={(e) => { e.stopPropagation(); closeTab(tab.id); }}
              sx={{ p: 0.2 }}
            >
              <Close sx={{ fontSize: 13 }} />
            </IconButton>
          </Box>
        );
      })}
    </Box>
  );
}
