import { ThemeProvider, CssBaseline } from '@mui/material';
import { theme, darkTheme } from './index';
import { useUiStore } from '../store/ui.store';

export function ThemeModeProvider({ children }: { children: React.ReactNode }) {
  const darkMode = useUiStore((s) => s.darkMode);
  return (
    <ThemeProvider theme={darkMode ? darkTheme : theme}>
      <CssBaseline />
      {children}
    </ThemeProvider>
  );
}
