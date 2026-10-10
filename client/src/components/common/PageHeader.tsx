import { useEffect } from 'react';
import { Box, Typography, Breadcrumbs, Link, Button, ButtonProps } from '@mui/material';
import { NavigateNext } from '@mui/icons-material';
import { useLocation, useNavigate } from 'react-router-dom';
import { useUiStore } from '../../store/ui.store';
import { useTabActive } from '../Layout/TabActiveContext';

interface Action {
  label: string;
  onClick: () => void;
  icon?: React.ReactNode;
  variant?: ButtonProps['variant'];
  color?: ButtonProps['color'];
}

interface Crumb {
  label: string;
  path?: string;
}

export type PageAction = Action;

interface Props {
  title: string;
  subtitle?: string;
  breadcrumbs?: Crumb[];
  actions?: Action[];
}

/**
 * A page's action buttons ("New PO", "Export CSV", …). PageHeader shows them itself, but a page that
 * has a filter/toolbar row should render them there instead (right-aligned, via `<Grid item sx={{ ml: 'auto' }}>`)
 * — otherwise a lone button costs a whole row above the filters.
 */
export function PageActions({ actions }: { actions?: Action[] }) {
  if (!actions || actions.length === 0) return null;
  return (
    <Box sx={{ display: 'flex', gap: 0.75, flexWrap: 'wrap' }}>
      {actions.map((action) => (
        <Button
          key={action.label}
          variant={action.variant ?? 'contained'}
          color={action.color ?? 'primary'}
          onClick={action.onClick}
          startIcon={action.icon}
          size="small"
          sx={{ whiteSpace: 'nowrap' }}
        >
          {action.label}
        </Button>
      ))}
    </Box>
  );
}

/**
 * The page name lives in the top bar, not in the page body — `title` is published there, and the
 * header itself renders only what the bar can't show: breadcrumbs, a subtitle, and action buttons.
 * A page whose only header content would be a lone button should put that button in its own
 * filter/toolbar row instead (and not pass `actions`), so the header costs no row at all.
 */
export function PageHeader({ title, subtitle, breadcrumbs, actions }: Props) {
  const navigate = useNavigate();
  const location = useLocation(); // inside a tab pane this is the tab's own location
  const locationKey = location.pathname + location.search;
  const setPageTitle = useUiStore((s) => s.setPageTitle);

  // Pages in background tabs stay mounted; only the one on screen owns the top-bar title.
  const tabActive = useTabActive();
  useEffect(() => {
    if (tabActive) setPageTitle(title, locationKey);
  }, [title, locationKey, tabActive, setPageTitle]);

  const hasActions = !!actions && actions.length > 0;

  const hasVisibleContent = !!breadcrumbs?.length || !!subtitle || hasActions;
  if (!hasVisibleContent) return null;

  return (
    <Box sx={{ mb: 2 }}>
      {breadcrumbs && (
        <Breadcrumbs separator={<NavigateNext fontSize="small" />} sx={{ mb: 1 }}>
          {breadcrumbs.map((crumb, i) =>
            crumb.path && i < breadcrumbs.length - 1 ? (
              <Link
                key={crumb.path}
                component="button"
                onClick={() => navigate(crumb.path!)}
                underline="hover"
                color="text.secondary"
                sx={{ fontSize: 13 }}
              >
                {crumb.label}
              </Link>
            ) : (
              <Typography key={crumb.label} color="text.primary" sx={{ fontSize: 13 }}>
                {crumb.label}
              </Typography>
            )
          )}
        </Breadcrumbs>
      )}
      <Box sx={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: 2, flexWrap: 'wrap' }}>
        <Box sx={{ minWidth: 0 }}>
          {subtitle && (
            <Typography variant="body2" color="text.secondary">
              {subtitle}
            </Typography>
          )}
        </Box>
        <PageActions actions={actions} />
      </Box>
    </Box>
  );
}
