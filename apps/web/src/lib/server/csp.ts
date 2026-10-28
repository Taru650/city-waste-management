import { serverConfig } from './config';

/** Per-request CSP. Scripts need the nonce; styles allow inline because antd injects CSS at runtime and Leaflet sets style attributes. */
export function buildCsp(nonce: string): string {
  const tiles = new URL(serverConfig.mapTileUrl.replace(/\{[a-z]\}/g, 'a')).origin;
  const media = serverConfig.mediaOrigins.join(' ');
  const dev = process.env.NODE_ENV === 'development';
  // hCaptcha (forgot-password) loads its script, frame and API from these hosts; only when configured.
  const captcha = serverConfig.hcaptchaSiteKey ? ' https://hcaptcha.com https://*.hcaptcha.com' : '';
  return [
    `default-src 'self'`,
    `script-src 'self' 'nonce-${nonce}' 'strict-dynamic'${dev ? ` 'unsafe-eval'` : ''}${captcha}`,
    `style-src 'self' 'unsafe-inline'`,
    `img-src 'self' data: blob: ${tiles} ${media}`.trim(),
    `media-src 'self' blob: ${media}`.trim(),
    `font-src 'self' data:`,
    `connect-src 'self'${captcha}`,
    ...(captcha ? [`frame-src${captcha}`] : []),
    `worker-src 'self' blob:`,
    `object-src 'none'`,
    `base-uri 'self'`,
    `form-action 'self'`,
    `frame-ancestors 'none'`,
    ...(serverConfig.portalOrigin?.startsWith('https://') ? ['upgrade-insecure-requests'] : []),
  ].join('; ');
}
