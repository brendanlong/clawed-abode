/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  // Mark native modules as external (moved from experimental in Next.js 16)
  serverExternalPackages: ['ssh2', 'simple-git'],
  // Empty turbopack config to acknowledge Turbopack is enabled by default
  turbopack: {},
  // Exclude the data directory from production build output tracing.
  // The data/ directory contains the SQLite database and sockets at runtime
  // and should not be included in the build output.
  outputFileTracingExcludes: {
    '/*': ['./data/**/*'],
  },
  async headers() {
    return [
      {
        source: '/:path*',
        headers: [
          { key: 'X-Frame-Options', value: 'DENY' },
          { key: 'X-Content-Type-Options', value: 'nosniff' },
          { key: 'Referrer-Policy', value: 'strict-origin-when-cross-origin' },
          {
            key: 'Content-Security-Policy',
            value: [
              "default-src 'self'",
              "script-src 'self' 'unsafe-inline'",
              "style-src 'self' 'unsafe-inline'",
              "img-src 'self' data: blob:",
              "font-src 'self' data:",
              "media-src 'self' blob:",
              "connect-src 'self'",
              "manifest-src 'self'",
              "object-src 'none'",
              "base-uri 'self'",
              "form-action 'self'",
              "frame-ancestors 'none'",
            ].join('; '),
          },
        ],
      },
    ];
  },
};

module.exports = nextConfig;
