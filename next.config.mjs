import nextConstants from 'next/constants.js';

/** @type {import('next').NextConfig} */
const nextConfig = (phase) => ({
  reactStrictMode: true,
  async headers() {
    return ['/', '/reset-password', '/auth/callback', '/client-upload/:path*'].map(source => ({ source, headers: [{ key: 'Referrer-Policy', value: 'no-referrer' }, { key: 'Cache-Control', value: 'no-store' }] }));
  },
  // A production build must not replace chunks used by a running dev server.
  distDir: phase === nextConstants.PHASE_DEVELOPMENT_SERVER ? '.next-dev' : '.next',
});

export default nextConfig;
