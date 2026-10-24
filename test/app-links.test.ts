/** The app-link files (src/http/appLinks.ts) on both deployments. */
import { afterEach, describe, expect, it } from 'vitest';
import { startServer, type TestServer } from './helpers.js';

const UPLOAD =
  'B8:D4:B9:44:09:76:F2:93:85:95:3F:B3:AF:5F:6F:58:99:C3:AC:03:62:4F:F5:64:5F:45:57:E6:96:76:08:C6';
const PIXAPPS = {
  CLUB_ANDROID_PACKAGE: 'com.pixapps.simplegames',
  CLUB_ANDROID_CERT_SHA256: UPLOAD.toLowerCase(),
  CLUB_IOS_APP_IDS: '8XR3LLAS54.com.pixapps.simplegames',
};
let server: TestServer;
afterEach(async () => {
  await server?.close();
});

describe('app links (/.well-known)', () => {
  it('names the configured app, for /join only', async () => {
    server = await startServer({ openJoin: true, appLinks: PIXAPPS });
    const android = await server.api('/.well-known/assetlinks.json');
    expect(android.status).toBe(200);
    expect(android.headers.get('content-type')).toMatch(/^application\/json/);
    expect(android.json).toEqual([
      {
        relation: ['delegate_permission/common.handle_all_urls'],
        target: {
          namespace: 'android_app',
          package_name: 'com.pixapps.simplegames',
          sha256_cert_fingerprints: [UPLOAD],
        },
      },
    ]);
    const apple = await server.api('/.well-known/apple-app-site-association');
    expect(apple.status).toBe(200);
    expect(apple.headers.get('content-type')).toMatch(/^application\/json/);
    expect(apple.json).toEqual({
      applinks: {
        details: [
          { appIDs: ['8XR3LLAS54.com.pixapps.simplegames'], components: [{ '/': '/join' }] },
        ],
      },
    });
  });

  it('claims no app when the deployment names none', async () => {
    server = await startServer({ openJoin: true });
    expect((await server.api('/.well-known/assetlinks.json')).status).toBe(404);
    expect((await server.api('/.well-known/apple-app-site-association')).status).toBe(404);
    expect((await server.api('/.well-known/anything-else')).status).toBe(404);
  });
});
