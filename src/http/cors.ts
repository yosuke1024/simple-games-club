/**
 * CORS as club.md §5-1 fixes it: the server's own origin, the two Capacitor
 * app origins, and whatever the host adds through CLUB_CORS_ORIGINS. Nothing
 * else — pixapps.ai included, until the day that route is designed (§7-3).
 */
export const APP_ORIGINS: readonly string[] = ['https://localhost', 'capacitor://localhost'];

export const ALLOWED_METHODS = 'GET, POST, PATCH, DELETE, OPTIONS';

export function corsHeaders(
  requestOrigin: string | undefined,
  selfOrigin: string,
  extra: readonly string[],
): Record<string, string> {
  if (requestOrigin === undefined) return {};
  const allowed =
    requestOrigin === selfOrigin ||
    APP_ORIGINS.includes(requestOrigin) ||
    extra.includes(requestOrigin);
  if (!allowed) return {};
  return {
    'Access-Control-Allow-Origin': requestOrigin,
    'Access-Control-Allow-Methods': ALLOWED_METHODS,
    'Access-Control-Allow-Headers': 'Authorization, Content-Type',
    'Access-Control-Expose-Headers': 'X-Club-Api',
    'Access-Control-Max-Age': '600',
    Vary: 'Origin',
  };
}
