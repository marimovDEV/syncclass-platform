import type { Metadata, Viewport } from 'next';
import { Inter, JetBrains_Mono } from 'next/font/google';

import './globals.css';

import { QueryProvider } from '@/components/shared/QueryProvider';
import { THEME_INIT_SCRIPT } from '@/components/shared/ThemeToggle';
import { Toaster } from '@/components/ui/toast';

// CONTRACTS.md §9 — Inter (UI), JetBrains Mono (kod).
const inter = Inter({
  subsets: ['latin', 'latin-ext'],
  display: 'swap',
  variable: '--font-inter',
  fallback: ['system-ui', '-apple-system', 'BlinkMacSystemFont', 'Segoe UI', 'Roboto', 'sans-serif'],
});

const jetbrainsMono = JetBrains_Mono({
  subsets: ['latin', 'latin-ext'],
  display: 'swap',
  variable: '--font-jetbrains-mono',
  fallback: ['ui-monospace', 'SFMono-Regular', 'Menlo', 'Monaco', 'Consolas', 'monospace'],
});

export const metadata: Metadata = {
  title: {
    default: 'SyncClass — jonli sinf',
    template: '%s · SyncClass',
  },
  description:
    'SyncClass — o’qituvchi va o’quvchilarni bir ekranda birlashtiruvchi jonli dars platformasi.',
  applicationName: 'SyncClass',
  robots: { index: false, follow: false },
};

export const viewport: Viewport = {
  width: 'device-width',
  initialScale: 1,
  maximumScale: 5,
  // ISTISNO (hardcoded rang): `<meta name="theme-color">` CSS o'zgaruvchisini o'qiy olmaydi.
  // Qiymatlar `globals.css` dagi `--bg` bilan AYNAN bir xil (yorug' 244 245 255, qorong'i 7 9 22).
  themeColor: [
    { media: '(prefers-color-scheme: light)', color: '#F4F5FF' },
    { media: '(prefers-color-scheme: dark)', color: '#070916' },
  ],
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="uz" suppressHydrationWarning>
      <head>
        {/*
          Mavzu birinchi bo'yoqdan OLDIN qo'yiladi — aks holda qorong'i rejimda
          oq ekran chaqnaydi (FOUC). Script inline va juda qisqa.
        */}
        <script dangerouslySetInnerHTML={{ __html: THEME_INIT_SCRIPT }} />
      </head>
      <body className={`${inter.variable} ${jetbrainsMono.variable} font-sans`}>
        <QueryProvider>
          {children}
          <Toaster />
        </QueryProvider>
      </body>
    </html>
  );
}
