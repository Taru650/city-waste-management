/**
 * Full page load, used on purpose after sign-in, sign-out and session expiry: it discards all
 * client-side cached data and re-runs the server-side session check. Client-side navigation
 * (router.push) would keep the previous user's SWR cache in memory.
 */
export function hardNavigate(path: string) {
  window.location.assign(path);
}
