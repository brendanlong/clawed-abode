/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  // Mark native modules as external (moved from experimental in Next.js 16)
  serverExternalPackages: ['dockerode', 'ssh2', 'simple-git'],
  // Empty turbopack config to acknowledge Turbopack is enabled by default
  turbopack: {},
};

module.exports = nextConfig;
