import { serverConfig } from './config';

/** Per-request CSP. Scripts need the nonce; styles allow inline because antd injects CSS at runtime and Leaflet sets style attributes. */
export function buildCsp(nonce: string): string {
  const tiles = new URL(serverConfig.mapTileUrl.replace(/\{[a-z]\}/g, 'a')).origin;
  const media = serverConfig.mediaOrigins.join(' ');
  const dev = process.env.NODE_ENV === 'development';
  return [
    `default-src 'self'`,
    `script-src 'self' 'nonce-${nonce}' 'strict-dynamic'${dev ? ` 'unsafe-eval'` : ''}`,
    `style-src 'self' 'unsafe-inline'`,
    `img-src 'self' data: blob: ${tiles} ${media}`.trim(),
    `media-src 'self' blob: ${media}`.trim(),
    `font-src 'self' data:`,
    `connect-src 'self'`,
    `worker-src 'self' blob:`,
    `object-src 'none'`,
    `base-uri 'self'`,
    `form-action 'self'`,
    `frame-ancestors 'none'`,
    ...(serverConfig.portalOrigin?.startsWith('https://') ? ['upgrade-insecure-requests'] : []),
  ].join('; ');
}
