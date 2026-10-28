import type { NextConfig } from 'next';

/** Static security headers; the per-request CSP (with nonce) is set in src/proxy.ts. */
const securityHeaders = [
  { key: 'Strict-Transport-Security', value: 'max-age=31536000; includeSubDomains; preload' },
  { key: 'X-Content-Type-Options', value: 'nosniff' },
  { key: 'X-Frame-Options', value: 'DENY' },
  { key: 'Referrer-Policy', value: 'no-referrer' },
  { key: 'Permissions-Policy', value: 'camera=(), microphone=(), geolocation=(), payment=(), usb=()' },
  { key: 'Cross-Origin-Opener-Policy', value: 'same-origin' },
];

const config: NextConfig = {
  output: 'standalone',
  poweredByHeader: false,
  reactStrictMode: true,
  async headers() {
    return [
      { source: '/:path*', headers: securityHeaders },
      // Static assets bypass the proxy (no per-request CSP). CSP does not affect how a script file
      // runs inside a page, but a locked-down policy keeps any asset opened directly inert.
      // Only here: a second CSP on pages would be intersected with the nonce policy.
      ...['/_next/static', '/_next/static/:path*'].map((source) => ({
        source, headers: [{ key: 'Content-Security-Policy', value: "default-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'" }],
      })),
    ];
  },
};

export default config;
