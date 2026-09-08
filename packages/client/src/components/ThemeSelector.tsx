import { useContext, useCallback, useEffect, useState } from 'react';
import { JSX } from 'react/jsx-runtime';
import { Sun, Moon, Monitor } from 'lucide-react';
import { ThemeContext, isDark } from '../theme';
import { useLocalize } from '../hooks';
import { Button } from './Button';

declare global {
  interface Window {
    lastThemeChange?: number;
  }
}

type ThemeType = 'system' | 'dark' | 'light';

const Theme = ({ theme, onChange }: { theme: string; onChange: (value: string) => void }) => {
  const localize = useLocalize();

  const themeIcons: Record<ThemeType, JSX.Element> = {
    system: <Monitor aria-hidden="true" />,
    dark: <Moon aria-hidden="true" />,
    light: <Sun aria-hidden="true" />,
  };

  const nextTheme = isDark(theme) ? 'light' : 'dark';

  useEffect(() => {
    const handleKeyPress = (e: KeyboardEvent) => {
      if (e.ctrlKey && e.shiftKey && e.key.toLowerCase() === 't') {
        e.preventDefault();
        onChange(nextTheme);
      }
    };
    window.addEventListener('keydown', handleKeyPress);
    return () => window.removeEventListener('keydown', handleKeyPress);
  }, [nextTheme, onChange]);

  return (
    <Button
      variant="ghost"
      size="icon"
      className="h-auto w-auto p-2 text-text-primary"
      aria-label={localize('com_ui_toggle_theme')}
      aria-keyshortcuts="Ctrl+Shift+T"
      onClick={(e) => {
        e.preventDefault();
        onChange(nextTheme);
      }}
    >
      {themeIcons[theme as ThemeType]}
    </Button>
  );
};

const ThemeSelector = ({ returnThemeOnly }: { returnThemeOnly?: boolean }): JSX.Element => {
  return <></>;
};

export default ThemeSelector;
