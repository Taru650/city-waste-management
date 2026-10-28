export interface CspOptions {
  /** Where map tiles come from (an origin such as https://tile.openstreetmap.org). */
  tileOrigin: string;
  /** Development needs eval for hot reload; never allowed otherwise. */
  dev: boolean;
  /** Ask browsers to upgrade http:// sub-requests (only when the site itself is served over HTTPS). */
  upgradeInsecure: boolean;
}

/**
 * Content-Security-Policy for the website's pages, one per request. Scripts need the request's nonce;
 * styles allow inline because Ant Design injects CSS at run time and Leaflet sets style attributes.
 * Photos and videos are served by this same app, so nothing else needs whitelisting.
 */
export function buildCsp(nonce: string, o: CspOptions): string {
  return [
    `default-src 'self'`,
    `script-src 'self' 'nonce-${nonce}' 'strict-dynamic'${o.dev ? ` 'unsafe-eval'` : ''}`,
    `style-src 'self' 'unsafe-inline'`,
    `img-src 'self' data: blob: ${o.tileOrigin}`,
    `media-src 'self' blob:`,
    `font-src 'self' data:`,
    `connect-src 'self'`,
    `worker-src 'self' blob:`,
    `object-src 'none'`,
    `base-uri 'self'`,
    `form-action 'self'`,
    `frame-ancestors 'none'`,
    ...(o.upgradeInsecure ? ['upgrade-insecure-requests'] : []),
  ].join('; ');
}
