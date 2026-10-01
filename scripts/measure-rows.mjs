// The cost drivers of the Cloudflare deployment, measured locally: for each
// request of one club's life (claim → invite → join → challenge → result →
// records) the rows the Durable Object read and wrote — the numbers SQLite
// storage is billed by — and the response size. Runs the deployed bundle in
// workerd (Miniflare), as the contract tests do; production figures come from
// the dashboard after a real deploy (docs/cloudflare.md).
//
//   pnpm measure:rows
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Miniflare, convertV4MiniflareOptions } from 'miniflare';
import { unstable_getMiniflareWorkerOptions } from 'wrangler';

const ROOT = join(import.meta.dirname, '..');
const SETUP_KEY = 'measure-setup-key-0123456789abcdef';

const { workerOptions } = unstable_getMiniflareWorkerOptions(join(ROOT, 'wrangler.toml'));
const { compatibilityDate, compatibilityFlags, durableObjects } = workerOptions;
const persist = mkdtempSync(join(tmpdir(), 'sg-club-measure-'));
const mf = new Miniflare(
  convertV4MiniflareOptions({
    workers: [
      {
        name: 'simple-games-club',
        rootPath: ROOT,
        modulesRoot: ROOT,
        modules: true,
        scriptPath: join(ROOT, 'dist-worker', 'index.js'),
        compatibilityDate,
        compatibilityFlags,
        durableObjects,
        bindings: { CLUB_SETUP_KEY: SETUP_KEY, CLUB_SECRET: 'measure-secret', CLUB_TEST_MODE: '1' },
      },
    ],
    durableObjectsPersist: persist,
  }),
);
const origin = (await mf.ready).origin;

const rows = [];
async function call(label, path, { method, token, body, ip } = {}) {
  const headers = {};
  if (token) headers.Authorization = `Bearer ${token}`;
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  if (ip) headers['CF-Connecting-IP'] = ip;
  const response = await fetch(`${origin}${path}`, {
    method: method ?? (body === undefined ? 'GET' : 'POST'),
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await response.text();
  const counted = /read=(\d+); written=(\d+)/.exec(response.headers.get('x-club-rows') ?? '');
  rows.push({
    label,
    request: `${method ?? (body === undefined ? 'GET' : 'POST')} ${path.replace(/\/(c|m|ch|inv)_[A-Za-z0-9_-]+/g, '/:id')}`,
    status: response.status,
    read: counted ? Number(counted[1]) : NaN,
    written: counted ? Number(counted[2]) : NaN,
    bytes: new TextEncoder().encode(text).byteLength,
  });
  return text === '' ? null : JSON.parse(text);
}

const challengeBody = (seed) => ({
  gameId: 'sudoku',
  contractVersion: 1,
  params: { difficulty: 'hard' },
  seed,
  boardDigest: 'sd1:9f3a1c07',
  title: null,
  result: { outcome: 'completed', facts: { elapsedSeconds: 271, mistakes: 0, hints: 1 } },
});
const resultBody = (elapsedSeconds) => ({
  contractVersion: 1,
  boardDigest: 'sd1:9f3a1c07',
  outcome: 'completed',
  facts: { elapsedSeconds, mistakes: 2, hints: 0 },
});

// --- One club's life, request by request ---------------------------------
await call('health, unclaimed', '/api/v1/health');
const owner = await call('claim', '/api/v1/claim', {
  body: { setupKey: SETUP_KEY, nickname: 'Yoh' },
});
await call('health, claimed', '/api/v1/health');
const invite = await call('read invite', '/api/v1/invite', { token: owner.memberToken });
const member = await call('join', '/api/v1/join', {
  body: { inviteToken: invite.token, nickname: 'Ken' },
  ip: '203.0.113.10',
});
await call('club (2 members)', '/api/v1/club', { token: member.memberToken });
const challenge = await call('create challenge + result', '/api/v1/challenges', {
  token: owner.memberToken,
  body: challengeBody('sudoku-free-mf8k2a-1x9q'),
});
await call('list challenges (1)', '/api/v1/challenges', { token: member.memberToken });
await call('one challenge', `/api/v1/challenges/${challenge.id}`, { token: member.memberToken });
await call('submit result', `/api/v1/challenges/${challenge.id}/results`, {
  token: member.memberToken,
  body: resultBody(305),
});
await call('results (2)', `/api/v1/challenges/${challenge.id}/results`, {
  token: owner.memberToken,
});
await call('records (1 challenge)', '/api/v1/records', { token: owner.memberToken });
await call('hosting', '/api/v1/hosting', { token: owner.memberToken });
await call('401 (bad token)', '/api/v1/club', { token: 'not-a-token' });
await call('409 (bad invite)', '/api/v1/join', {
  body: { inviteToken: 'nope', nickname: 'Eve' },
  ip: '203.0.113.11',
});
await call('409 (second result)', `/api/v1/challenges/${challenge.id}/results`, {
  token: member.memberToken,
  body: resultBody(300),
});

// --- The same reads in a fuller club: 20 members, 10 challenges, 200 results
const members = [owner, member];
for (let i = members.length; i < 20; i++) {
  members.push(
    await call('(seed) join', '/api/v1/join', {
      body: { inviteToken: invite.token, nickname: `M${i}` },
      ip: `203.0.114.${i}`,
    }),
  );
}
const challenges = [challenge];
for (let i = 1; i < 10; i++) {
  challenges.push(
    await call('(seed) challenge', '/api/v1/challenges', {
      token: members[i % members.length].memberToken,
      body: challengeBody(`seed-${i}`),
    }),
  );
}
for (const [c, ch] of challenges.entries()) {
  for (const [m, who] of members.entries()) {
    if ((c === 0 && m < 2) || (c > 0 && m === c % members.length)) continue;
    await call('(seed) result', `/api/v1/challenges/${ch.id}/results`, {
      token: who.memberToken,
      body: resultBody(200 + m),
    });
  }
}
const seeded = rows.filter((r) => r.label.startsWith('(seed)'));
const full = rows.length;
await call('club (20 members)', '/api/v1/club', { token: member.memberToken });
await call('list challenges (10)', '/api/v1/challenges', { token: member.memberToken });
await call('results (20)', `/api/v1/challenges/${challenge.id}/results`, {
  token: owner.memberToken,
});
await call('records (10 challenges, 200 results)', '/api/v1/records', { token: owner.memberToken });

await mf.dispose();
rmSync(persist, { recursive: true, force: true });

const table = (list) => {
  console.log('| Step | Request | Status | Rows read | Rows written | Response bytes |');
  console.log('| --- | --- | ---: | ---: | ---: | ---: |');
  for (const r of list) {
    console.log(
      `| ${r.label} | \`${r.request}\` | ${r.status} | ${r.read} | ${r.written} | ${r.bytes} |`,
    );
  }
};
console.log(
  `\nMeasured in workerd ${compatibilityDate} via Miniflare, ${new Date().toISOString().slice(0, 10)}.\n`,
);
console.log('### One club, request by request\n');
table(rows.filter((r, i) => i < full && !r.label.startsWith('(seed)')));
console.log('\n### The same reads with 20 members, 10 challenges, 200 results\n');
table(rows.slice(full));
const sum = (list, key) => list.reduce((n, r) => n + r[key], 0);
console.log(
  `\nSeeding the fuller club took ${seeded.length} requests, ${sum(seeded, 'read')} rows read, ${sum(seeded, 'written')} rows written.`,
);
