/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  // Empty turbopack config to acknowledge Turbopack is enabled by default
  turbopack: {},
  // Next strips trailing slashes by default, which loops with the /public route's
  // redirect *to* a trailing slash (directory pages need one for relative links).
  // App-wide, so app pages also answer at `/x/`; nothing links there.
  skipTrailingSlashRedirect: true,
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
      {
        // Agent-written pages (src/app/public/) must not run as the app's origin:
        // a page — or a CDN script it pulls in — could otherwise read the bearer
        // token from localStorage. The sandbox gives them an opaque origin; they
        // may still load third-party resources. Later entries override earlier ones.
        source: '/public/:path*',
        headers: [
          {
            key: 'Content-Security-Policy',
            value:
              "sandbox allow-scripts allow-forms allow-popups allow-popups-to-escape-sandbox allow-modals allow-downloads; frame-ancestors 'none'",
          },
          // The URL carries the session id; don't leak it to CDNs the page loads.
          { key: 'Referrer-Policy', value: 'no-referrer' },
        ],
      },
    ];
  },
};

module.exports = nextConfig;
