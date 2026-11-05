import type { Config } from 'tailwindcss';
import animate from 'tailwindcss-animate';

// CONTRACTS.md §9 — dizayn tokenlari CSS o'zgaruvchilaridan o'qiladi (globals.css).
const config: Config = {
  darkMode: ['class', ':root[data-theme="dark"]'],
  content: ['./src/**/*.{ts,tsx,mdx}'],
  theme: {
    container: {
      center: true,
      padding: '1rem',
      screens: { sm: '640px', md: '768px', lg: '1024px', xl: '1280px', '2xl': '1536px' },
    },
    extend: {
      screens: {
        // CONTRACTS.md §9: <768 Mobile Companion · 768–1279 Split-View · >=1280 Studio
        companion: { max: '767px' },
        split: { min: '768px', max: '1279px' },
        studio: '1280px',
      },
      colors: {
        bg: 'rgb(var(--bg) / <alpha-value>)',
        surface: 'rgb(var(--surface) / <alpha-value>)',
        /** DESIGN_GLOW §3 — ichma-ich yuza (kartochka ichidagi blok, faol tab). */
        'surface-2': 'rgb(var(--surface-2) / <alpha-value>)',
        border: 'rgb(var(--border) / <alpha-value>)',
        fg: 'rgb(var(--fg) / <alpha-value>)',
        muted: 'rgb(var(--muted) / <alpha-value>)',
        primary: {
          DEFAULT: 'rgb(var(--primary) / <alpha-value>)',
          fg: 'rgb(var(--primary-fg) / <alpha-value>)',
        },
        accent: {
          DEFAULT: 'rgb(var(--accent) / <alpha-value>)',
          fg: 'rgb(var(--accent-fg) / <alpha-value>)',
        },
        danger: {
          DEFAULT: 'rgb(var(--danger) / <alpha-value>)',
          fg: 'rgb(var(--danger-fg) / <alpha-value>)',
        },
        success: {
          DEFAULT: 'rgb(var(--success) / <alpha-value>)',
          fg: 'rgb(var(--success-fg) / <alpha-value>)',
        },
        ring: 'rgb(var(--ring) / <alpha-value>)',
        /** Modal fon pardasi — ikkala rejimda ham QORONG'I (`--shadow-color` dan). */
        scrim: 'rgb(var(--shadow-color) / <alpha-value>)',
      },
      borderRadius: {
        xl: 'var(--radius-xl)',
        '2xl': 'var(--radius-2xl)',
      },
      boxShadow: {
        soft: 'var(--shadow-soft)',
        lifted: 'var(--shadow-lifted)',
        /*
         * DESIGN_GLOW §2 — glow FAQAT: primary tugma, fokus, LIVE nishoni, faol slayd,
         * taymer halqasi. IDE, jadval, hisobot, kod bloklari va uzun matnda ISHLATILMAYDI.
         */
        'glow-primary': 'var(--glow-primary)',
        'glow-accent': 'var(--glow-accent)',
        'glow-soft': 'var(--glow-soft)',
      },
      fontFamily: {
        sans: ['var(--font-inter)', 'ui-sans-serif', 'system-ui', 'sans-serif'],
        mono: ['var(--font-jetbrains-mono)', 'ui-monospace', 'SFMono-Regular', 'monospace'],
      },
      transitionDuration: {
        fast: '150ms',
        DEFAULT: '180ms',
        slow: '220ms',
      },
      keyframes: {
        'fade-in': { from: { opacity: '0' }, to: { opacity: '1' } },
        'slide-up': {
          from: { opacity: '0', transform: 'translateY(8px)' },
          to: { opacity: '1', transform: 'translateY(0)' },
        },
        'pop-in': {
          '0%': { opacity: '0', transform: 'scale(0.92)' },
          '60%': { opacity: '1', transform: 'scale(1.03)' },
          '100%': { opacity: '1', transform: 'scale(1)' },
        },
        shimmer: {
          '100%': { transform: 'translateX(100%)' },
        },
        /* LIVE nuqtasi — faqat `transform`/`opacity`; har doim `motion-safe:` bilan. */
        'live-pulse': {
          '0%': { opacity: '0.75', transform: 'scale(1)' },
          '70%, 100%': { opacity: '0', transform: 'scale(2.4)' },
        },
      },
      animation: {
        'fade-in': 'fade-in 180ms ease-out',
        'slide-up': 'slide-up 200ms ease-out',
        'pop-in': 'pop-in 220ms cubic-bezier(0.34, 1.56, 0.64, 1)',
        shimmer: 'shimmer 1.4s infinite',
        'live-pulse': 'live-pulse 1.8s cubic-bezier(0, 0, 0.2, 1) infinite',
      },
    },
  },
  plugins: [animate],
};

export default config;
