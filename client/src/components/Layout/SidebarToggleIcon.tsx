import { SvgIcon, SvgIconProps } from '@mui/material';

/** A window with a left-hand panel. Panel filled = sidebar pinned open; outline only = auto-hide. */
export function SidebarToggleIcon({ filled, ...props }: SvgIconProps & { filled?: boolean }) {
  return (
    <SvgIcon {...props}>
      <rect x="3" y="4" width="18" height="16" rx="3" fill="none" stroke="currentColor" strokeWidth="1.8" />
      {filled && <path d="M6 4.9h3.6v14.2H6A2.1 2.1 0 0 1 3.9 17V7A2.1 2.1 0 0 1 6 4.9z" fill="currentColor" />}
      <line x1="9.6" y1="4.9" x2="9.6" y2="19.1" stroke="currentColor" strokeWidth="1.8" />
    </SvgIcon>
  );
}
