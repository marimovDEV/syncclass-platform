'use client';

import * as React from 'react';
import { Monitor, Moon, Sun } from 'lucide-react';

import { cn } from '@/lib/utils';
import { Button } from '@/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';

export type ThemePreference = 'light' | 'dark' | 'system';

const STORAGE_KEY = 'syncclass.theme';

/** `layout.tsx` ichida `<script>` sifatida ishlaydi — FOUC bo'lmasin. */
export const THEME_INIT_SCRIPT = `(function(){try{var t=localStorage.getItem('${STORAGE_KEY}');if(t==='light'||t==='dark'){document.documentElement.setAttribute('data-theme',t);}}catch(e){}})();`;

function readPreference(): ThemePreference {
  try {
    const stored = window.localStorage.getItem(STORAGE_KEY);
    if (stored === 'light' || stored === 'dark') return stored;
  } catch {
    /* ignore */
  }
  return 'system';
}

function applyPreference(preference: ThemePreference): void {
  const root = document.documentElement;
  if (preference === 'system') {
    root.removeAttribute('data-theme');
  } else {
    root.setAttribute('data-theme', preference);
  }
  try {
    if (preference === 'system') window.localStorage.removeItem(STORAGE_KEY);
    else window.localStorage.setItem(STORAGE_KEY, preference);
  } catch {
    /* ignore */
  }
}

/** Mavzu holatini o'qish/yozish uchun hook (boshqa komponentlar ham ishlatishi mumkin). */
export function useTheme(): {
  preference: ThemePreference;
  setPreference: (next: ThemePreference) => void;
  mounted: boolean;
} {
  const [preference, setPreferenceState] = React.useState<ThemePreference>('system');
  const [mounted, setMounted] = React.useState(false);

  React.useEffect(() => {
    setPreferenceState(readPreference());
    setMounted(true);
  }, []);

  const setPreference = React.useCallback((next: ThemePreference) => {
    applyPreference(next);
    setPreferenceState(next);
  }, []);

  return { preference, setPreference, mounted };
}

const OPTIONS: { value: ThemePreference; label: string; Icon: typeof Sun }[] = [
  { value: 'light', label: 'Yorug’', Icon: Sun },
  { value: 'dark', label: 'Qorong’i', Icon: Moon },
  { value: 'system', label: 'Tizim bo’yicha', Icon: Monitor },
];

export function ThemeToggle({ className }: { className?: string }) {
  const { preference, setPreference, mounted } = useTheme();

  // Hydration mos kelishi uchun server va birinchi render bir xil ikonka beradi.
  const active = mounted ? preference : 'system';
  const ActiveIcon = OPTIONS.find((option) => option.value === active)?.Icon ?? Monitor;

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          variant="ghost"
          size="icon"
          className={cn('text-muted hover:text-fg', className)}
          aria-label="Mavzuni almashtirish"
        >
          <ActiveIcon aria-hidden />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end">
        {OPTIONS.map(({ value, label, Icon }) => (
          <DropdownMenuItem
            key={value}
            onSelect={() => setPreference(value)}
            className={cn(active === value && 'text-primary')}
          >
            <Icon aria-hidden />
            {label}
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
