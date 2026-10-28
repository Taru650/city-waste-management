/** Server-side configuration. Nothing here is sent to the browser. */
export const serverConfig = {
  apiUrl: (process.env.API_URL ?? 'http://127.0.0.1:3000/api/v1').replace(/\/$/, ''),
  portalOrigin: process.env.PORTAL_ORIGIN,
  mediaOrigins: (process.env.MEDIA_ORIGINS ?? '').split(',').map((s) => s.trim()).filter(Boolean),
  mapTileUrl: process.env.MAP_TILE_URL ?? 'https://tile.openstreetmap.org/{z}/{x}/{y}.png',
  cookieSecure: process.env.COOKIE_SECURE !== 'false',
  /** hCaptcha site key (public). The API requires CAPTCHA on forgot-password in production. */
  hcaptchaSiteKey: process.env.HCAPTCHA_SITE_KEY || undefined,
};

export const COOKIES = {
  access: 'cwm_at',
  refresh: 'cwm_rt',
  mfa: 'cwm_mfa',
} as const;
