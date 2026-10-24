/**
 * The two files that let an installed Simple Games app open this server's invite
 * links itself (Android App Links, iOS Universal Links): without the app, the same
 * `/join` link is the web Join page (simple-games docs/architecture/club.md §7-1).
 *
 * Which app may claim them is the deployment's to say, never this code's: a server
 * someone else runs must not hand PixApps' app its links, and a fork's app is not
 * PixApps'. Unset, both paths are 404 — the server is exactly what it was.
 *
 *   CLUB_ANDROID_PACKAGE        com.pixapps.simplegames
 *   CLUB_ANDROID_CERT_SHA256    comma-separated signing-certificate SHA-256s (AA:BB:…)
 *   CLUB_IOS_APP_IDS            comma-separated <Team ID>.<bundle id>
 *
 * Only `/join` is claimed: every other address on the host stays the browser's.
 */
export interface AppLinksConfig {
  android: { packageName: string; certSha256: string[] } | null;
  iosAppIds: string[];
}

const list = (value: string | undefined): string[] =>
  (value ?? '')
    .split(',')
    .map((item) => item.trim())
    .filter((item) => item !== '');

const PACKAGE = /^[A-Za-z][A-Za-z0-9_]*(\.[A-Za-z][A-Za-z0-9_]*)+$/;
const SHA256 = /^([0-9A-F]{2}:){31}[0-9A-F]{2}$/;
const IOS_APP_ID = /^[A-Z0-9]{10}\.[A-Za-z0-9.-]+$/;

export function appLinksFrom(env: {
  CLUB_ANDROID_PACKAGE?: string;
  CLUB_ANDROID_CERT_SHA256?: string;
  CLUB_IOS_APP_IDS?: string;
}): AppLinksConfig {
  const packageName = env.CLUB_ANDROID_PACKAGE?.trim() ?? '';
  const certSha256 = list(env.CLUB_ANDROID_CERT_SHA256).map((s) => s.toUpperCase());
  const iosAppIds = list(env.CLUB_IOS_APP_IDS);
  // A malformed value is a deployment mistake to see at once, not a file that quietly
  // claims nothing (or the wrong app).
  if (packageName !== '' && !PACKAGE.test(packageName)) {
    throw new Error('CLUB_ANDROID_PACKAGE is not an Android package name');
  }
  if (certSha256.some((s) => !SHA256.test(s))) {
    throw new Error('CLUB_ANDROID_CERT_SHA256 must be colon-separated SHA-256 fingerprints');
  }
  if (iosAppIds.some((id) => !IOS_APP_ID.test(id))) {
    throw new Error('CLUB_IOS_APP_IDS must be <Team ID>.<bundle id>');
  }
  return {
    android: packageName !== '' && certSha256.length > 0 ? { packageName, certSha256 } : null,
    iosAppIds,
  };
}

export const ASSET_LINKS_PATH = '/.well-known/assetlinks.json';
export const APPLE_APP_SITE_ASSOCIATION_PATH = '/.well-known/apple-app-site-association';

/** The body for one of the two paths, or null (404) when this deployment names no app for it. */
export function appLinksBody(path: string, config: AppLinksConfig): string | null {
  if (path === ASSET_LINKS_PATH && config.android !== null) {
    return JSON.stringify([
      {
        relation: ['delegate_permission/common.handle_all_urls'],
        target: {
          namespace: 'android_app',
          package_name: config.android.packageName,
          sha256_cert_fingerprints: config.android.certSha256,
        },
      },
    ]);
  }
  if (path === APPLE_APP_SITE_ASSOCIATION_PATH && config.iosAppIds.length > 0) {
    return JSON.stringify({
      applinks: { details: [{ appIDs: config.iosAppIds, components: [{ '/': '/join' }] }] },
    });
  }
  return null;
}
