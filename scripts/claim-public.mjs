// Claims the Public Club House's fresh Durable Object (simple-games
// docs/architecture/club.md §17-4): the first owner exchanges the setup key for
// a member token and names the club "PixApps Club".
//
//   node scripts/claim-public.mjs [nickname]        (default nickname: Yoh)
//
// The setup key is read from data/cloudflare-spike.setup-key, or from
// CLUB_SETUP_KEY when set. CLUB_URL defaults to https://club.pixapps.ai.
// The club and member ids are printed; the member token never is — it goes only
// into data/public.session.json ({ url, claimedAt, owner }), which is gitignored
// (data/). The same key may claim again only after the object it was spent in is
// replaced, which is the point of a new CLUB_OBJECT_NAME. No CF-Connecting-IP is
// sent: the client address is Cloudflare's to name.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = join(import.meta.dirname, '..');
const KEY_FILE = join(ROOT, 'data', 'cloudflare-spike.setup-key');
const SESSION_FILE = join(ROOT, 'data', 'public.session.json');

const url = (process.env.CLUB_URL ?? 'https://club.pixapps.ai').replace(/\/+$/, '');
const nickname = process.argv[2] ?? 'Yoh';
const setupKey = (
  process.env.CLUB_SETUP_KEY ?? (existsSync(KEY_FILE) ? readFileSync(KEY_FILE, 'utf8') : '')
).trim();
if (setupKey === '') {
  throw new Error(`no setup key: set CLUB_SETUP_KEY or put it in ${KEY_FILE}`);
}
if (existsSync(SESSION_FILE)) {
  throw new Error(`${SESSION_FILE} already exists; move it aside to claim again`);
}

const response = await fetch(`${url}/api/v1/claim`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ setupKey, nickname, clubName: 'PixApps Club' }),
});
const text = await response.text();
let reply;
try {
  reply = JSON.parse(text);
} catch {
  throw new Error(`claim: ${response.status}, not JSON: ${text.slice(0, 200)}`);
}
if (response.status !== 201 || typeof reply.memberToken !== 'string') {
  throw new Error(`claim: ${response.status} ${JSON.stringify(reply.error ?? reply)}`);
}

// The claim's whole reply ({ club, member, memberToken }), the shape measure-rows.mjs saves.
const owner = reply;
mkdirSync(join(ROOT, 'data'), { recursive: true });
writeFileSync(
  SESSION_FILE,
  JSON.stringify({ url, claimedAt: new Date().toISOString(), owner }, null, 2),
  { mode: 0o600 },
);
console.log(`claimed ${url}`);
console.log(`club   ${reply.club.id}  "${reply.club.name}"`);
console.log(`member ${reply.member.id}  "${reply.member.nickname}" (${reply.member.role})`);
console.log(`saved the session to ${SESSION_FILE}`);
