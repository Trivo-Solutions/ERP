import { createTheme, alpha, Shadows, Theme } from '@mui/material/styles';

// ── Trivo Brand Palette ───────────────────────────────────────────────────────
// Extracted from Trivo Logo 512.png
// Primary: Deep Navy  #1B3280
// Accent:  Emerald    #44C47A

const NAVY = {
  50:  '#E8EBF5',
  100: '#C5CEEA',
  200: '#9EAFDE',
  300: '#7790D2',
  400: '#5876C9',
  500: '#3A5BBF',
  600: '#2947B3',
  700: '#1B3280',   // ← logo navy (primary.main)
  800: '#122262',
  900: '#091345',
};

const EMERALD = {
  50:  '#E8F8EF',
  100: '#C5EDD8',
  200: '#9EE1BF',
  300: '#76D4A6',
  400: '#57CB8F',
  500: '#44C47A',   // ← logo emerald (secondary.main)
  600: '#35AD68',
  700: '#279556',
  800: '#1A7D44',
  900: '#0D5E30',
};

// Palette differs only in `mode`/`background` between light and dark — built via a function
// (rather than spreading one resolved theme's `.palette` into the other's `createTheme()` call)
// so MUI auto-derives mode-correct `text`/`divider`/`action` tokens for each. Spreading a
// resolved palette bakes in whichever mode computed it first — text stayed light-mode dark-gray
// even inside `darkTheme`, unreadable against its dark background. Shipped once — don't
// reintroduce it.
function buildPalette(mode: 'light' | 'dark') {
  return {
    mode,
    primary: {
      main:         NAVY[700],    // #1B3280
      light:        NAVY[500],
      dark:         NAVY[900],
      contrastText: '#FFFFFF',
    },
    secondary: {
      main:         EMERALD[500], // #44C47A
      light:        EMERALD[300],
      dark:         EMERALD[700],
      contrastText: '#FFFFFF',
    },
    background: mode === 'light'
      ? { default: '#F4F6FB', paper: '#FFFFFF' }           // faint navy-tinted page background
      : { default: '#060D2A', paper: '#0D1840' },
    error:   { main: '#C62828' },
    warning: { main: '#E65100' },
    info:    { main: NAVY[500] },
    success: { main: EMERALD[700] },
  } as const;
}

const typography = {
  fontFamily: '"Roboto", "Helvetica", "Arial", sans-serif',
  h1: { fontWeight: 700, fontSize: '2.5rem' },
  h2: { fontWeight: 700, fontSize: '2rem' },
  h3: { fontWeight: 600, fontSize: '1.75rem' },
  h4: { fontWeight: 600, fontSize: '1.5rem' },
  h5: { fontWeight: 600, fontSize: '1.25rem' },
  h6: { fontWeight: 600, fontSize: '1rem' },
  subtitle1: { fontWeight: 500 },
  subtitle2: { fontWeight: 500, fontSize: '0.875rem' },
  body1:   { fontSize: '0.9375rem' },
  body2:   { fontSize: '0.875rem' },
  caption: { fontSize: '0.75rem', color: 'text.secondary' },
  button:  { fontWeight: 600, textTransform: 'none' },
  overline: { fontWeight: 600, letterSpacing: '0.1em' },
} as const;

const shape = { borderRadius: 12 };

const shadows: Shadows = [
    'none',
    '0 1px 2px rgba(0,0,0,0.06), 0 1px 3px rgba(0,0,0,0.1)',
    '0 2px 4px rgba(0,0,0,0.06), 0 2px 6px rgba(0,0,0,0.1)',
    '0 4px 8px rgba(0,0,0,0.06), 0 4px 12px rgba(0,0,0,0.1)',
    '0 6px 12px rgba(0,0,0,0.06), 0 6px 18px rgba(0,0,0,0.1)',
    '0 8px 16px rgba(0,0,0,0.06), 0 8px 24px rgba(0,0,0,0.1)',
    '0 10px 20px rgba(0,0,0,0.06), 0 10px 30px rgba(0,0,0,0.1)',
    '0 12px 24px rgba(0,0,0,0.06), 0 12px 36px rgba(0,0,0,0.1)',
    '0 14px 28px rgba(0,0,0,0.06), 0 14px 42px rgba(0,0,0,0.1)',
    '0 16px 32px rgba(0,0,0,0.06)',
    '0 18px 36px rgba(0,0,0,0.06)',
    '0 20px 40px rgba(0,0,0,0.06)',
    '0 22px 44px rgba(0,0,0,0.06)',
    '0 24px 48px rgba(0,0,0,0.06)',
    '0 26px 52px rgba(0,0,0,0.06)',
    '0 28px 56px rgba(0,0,0,0.06)',
    '0 30px 60px rgba(0,0,0,0.06)',
    '0 32px 64px rgba(0,0,0,0.06)',
    '0 34px 68px rgba(0,0,0,0.06)',
    '0 36px 72px rgba(0,0,0,0.06)',
    '0 38px 76px rgba(0,0,0,0.06)',
    '0 40px 80px rgba(0,0,0,0.06)',
    '0 42px 84px rgba(0,0,0,0.06)',
    '0 44px 88px rgba(0,0,0,0.06)',
    '0 46px 92px rgba(0,0,0,0.06)',
  ];

// Everything here is mode-independent except MuiTableHead, which needs to swap out of its
// light-mode pale-blue header band in dark mode — otherwise every table header stays a bright
// "light island" against a dark page (found while verifying dark mode against a real table).
function buildComponents(mode: 'light' | 'dark') {
  return {
    MuiCard: {
      styleOverrides: {
        root: {
          borderRadius: 16,
          boxShadow: '0 2px 8px rgba(27,50,128,0.08)',
          border: '1px solid rgba(27,50,128,0.07)',
        },
      },
    },
    MuiButton: {
      styleOverrides: {
        root: {
          borderRadius: 10,
          padding: '8px 20px',
          fontWeight: 600,
          boxShadow: 'none',
          '&:hover': { boxShadow: '0 2px 6px rgba(27,50,128,0.2)' },
        },
        contained: {
          '&:active': { boxShadow: 'none' },
        },
      },
    },
    MuiTextField: {
      defaultProps: { size: 'small' as const, variant: 'outlined' as const },
      styleOverrides: {
        root: {
          '& .MuiOutlinedInput-root': { borderRadius: 10 },
        },
      },
    },
    // Every keyboard-first dropdown (SelectField / `SelectProps={{ native: true }}`) is a real <select>, whose
    // popup the browser draws — so the theme can't restyle its shape, only what the browser lets through:
    // colour-scheme (dark popup + scrollbar in dark mode), and the option/optgroup colours and font.
    MuiNativeSelect: {
      styleOverrides: {
        select: ({ theme }: { theme: Theme }) => ({
          colorScheme: mode,
          '& option, & optgroup': {
            backgroundColor: theme.palette.background.paper,
            color: theme.palette.text.primary,
            fontFamily: theme.typography.fontFamily,
            fontSize: '0.9375rem',
          },
          '& option:checked': {
            backgroundColor: alpha(EMERALD[500], 0.25),
            color: theme.palette.text.primary,
          },
          '& option:disabled': { color: theme.palette.text.disabled },
        }),
      },
    },
    MuiChip: {
      styleOverrides: {
        root: { fontWeight: 600, borderRadius: 8 },
      },
    },
    MuiTableHead: {
      styleOverrides: {
        root: {
          '& .MuiTableCell-head': {
            fontWeight: 700,
            fontSize: '0.75rem',
            textTransform: 'uppercase',
            letterSpacing: '0.05em',
            color: mode === 'light' ? NAVY[700] : EMERALD[300],
            backgroundColor: mode === 'light' ? '#EEF1FA' : alpha(NAVY[500], 0.25),
          },
        },
      },
    },
    MuiAppBar: {
      styleOverrides: {
        root: {
          boxShadow: '0 1px 3px rgba(27,50,128,0.12)',
          backdropFilter: 'blur(8px)',
        },
      },
    },
    MuiListItemButton: {
      styleOverrides: {
        root: {
          borderRadius: 10,
          margin: '2px 8px',
          '&.Mui-selected': {
            backgroundColor: alpha(EMERALD[500], 0.18),
            '&:hover': { backgroundColor: alpha(EMERALD[500], 0.28) },
          },
          '&:hover': { backgroundColor: alpha('#FFFFFF', 0.08) },
        },
      },
    },
    MuiLinearProgress: {
      styleOverrides: { root: { borderRadius: 4 } },
    },
    MuiAlert: {
      styleOverrides: { root: { borderRadius: 10 } },
    },
  };
}

export const theme = createTheme({
  palette: buildPalette('light'),
  typography,
  shape,
  shadows,
  components: buildComponents('light'),
});

export const darkTheme = createTheme({
  palette: buildPalette('dark'),
  typography,
  shape,
  shadows,
  components: buildComponents('dark'),
});
