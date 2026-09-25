import { useEffect } from 'react';
import { Box, Typography, Breadcrumbs, Link, Button, ButtonProps } from '@mui/material';
import { NavigateNext } from '@mui/icons-material';
import { useNavigate } from 'react-router-dom';
import { useUiStore } from '../../store/ui.store';

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

interface Props {
  title: string;
  subtitle?: string;
  breadcrumbs?: Crumb[];
  actions?: Action[];
  /** Hide the in-page title (e.g. when it's already shown in the top bar) — subtitle/actions still render. */
  hideTitle?: boolean;
}

export function PageHeader({ title, subtitle, breadcrumbs, actions, hideTitle }: Props) {
  const navigate = useNavigate();
  const setPageTitle = useUiStore((s) => s.setPageTitle);

  useEffect(() => {
    setPageTitle(title);
  }, [title, setPageTitle]);

  const hasVisibleContent = !!breadcrumbs?.length || !hideTitle || !!subtitle || !!actions?.length;
  if (!hasVisibleContent) return null;

  return (
    <Box sx={{ mb: 3 }}>
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
      <Box sx={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: 2 }}>
        <Box>
          {!hideTitle && (
            <Typography variant="h5" fontWeight={700} color="text.primary">
              {title}
            </Typography>
          )}
          {subtitle && (
            <Typography variant="body2" color="text.secondary" sx={{ mt: 0.5 }}>
              {subtitle}
            </Typography>
          )}
        </Box>
        {actions && actions.length > 0 && (
          <Box sx={{ display: 'flex', gap: 1, flexShrink: 0 }}>
            {actions.map((action) => (
              <Button
                key={action.label}
                variant={action.variant ?? 'contained'}
                color={action.color ?? 'primary'}
                onClick={action.onClick}
                startIcon={action.icon}
                size="small"
              >
                {action.label}
              </Button>
            ))}
          </Box>
        )}
      </Box>
    </Box>
  );
}
