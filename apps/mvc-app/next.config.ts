import type { NextConfig } from 'next';

/** Static security headers for every response; the per-request CSP (with nonce) is set in src/proxy.ts. */
const securityHeaders = [
  { key: 'Strict-Transport-Security', value: 'max-age=31536000; includeSubDomains' },
  { key: 'X-Content-Type-Options', value: 'nosniff' },
  { key: 'X-Frame-Options', value: 'DENY' },
  { key: 'Referrer-Policy', value: 'no-referrer' },
  { key: 'Permissions-Policy', value: 'camera=(), microphone=(), geolocation=(), payment=(), usb=()' },
  { key: 'Cross-Origin-Opener-Policy', value: 'same-origin' },
];

const config: NextConfig = {
  // Do not generate an AGENTS.md file in the project folder.
  agentRules: false,
  poweredByHeader: false,
  reactStrictMode: true,
  // Native / Node-only packages stay out of the bundle (they are required at run time).
  serverExternalPackages: ['knex', 'mysql2', '@node-rs/argon2', 'sharp', 'exceljs'],
  async headers() {
    return [{ source: '/:path*', headers: securityHeaders }];
  },
};

export default config;
