import type { NextConfig } from 'next';

const nextConfig: NextConfig = {
  // Docker uchun: minimal server bundle (devops-engineer Dockerfile shunga tayanadi).
  output: 'standalone',
  reactStrictMode: true,
  poweredByHeader: false,
  eslint: {
    // Lint alohida `npm run lint` bilan ishlatiladi, build ni bloklamaydi.
    ignoreDuringBuilds: true,
  },
  typescript: {
    // Tip xatolari build ni TO'XTATADI — bu ataylab true emas.
    ignoreBuildErrors: false,
  },
  images: {
    remotePatterns: [
      { protocol: 'https', hostname: 'lh3.googleusercontent.com' },
      { protocol: 'https', hostname: '*.r2.cloudflarestorage.com' },
    ],
  },
};

export default nextConfig;
