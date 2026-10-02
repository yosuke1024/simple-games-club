// The cost drivers of the Cloudflare deployment, measured: for each request of
// one club's life (claim → invite → join → challenge → result → records) the
// rows the Durable Object read and wrote — the numbers SQLite storage is billed
// by — the response size, and the round-trip time. Two modes:
//
//   pnpm measure:rows
//       the deployed bundle in workerd (Miniflare); rows come back on the
//       X-Club-Rows header, which only test mode sets
//   CLUB_URL=https://… CLUB_SETUP_KEY=… node scripts/measure-rows.mjs
//       a real deployment; rows are read from the dashboard instead, and the
//       time is the real round trip. The owner the claim creates is kept in
//       data/cloudflare-spike.session.json (gitignored) and a later run
//       continues as that owner instead of claiming again.
//
// A partial run still prints every reply it got, including the ones that were
// not JSON (Cloudflare's own error pages). Production figures belong in
// docs/cloudflare.md §7.
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const ROOT = join(import.meta.dirname, '..');
const SESSION_FILE = join(ROOT, 'data', 'cloudflare-spike.session.json');
const live = process.env.CLUB_URL?.replace(/\/+$/, '') ?? null;
const SETUP_KEY = live ? process.env.CLUB_SETUP_KEY : 'measure-setup-key-0123456789abcdef';
if (live && !SETUP_KEY && !existsSync(SESSION_FILE)) {
  throw new Error('CLUB_URL needs CLUB_SETUP_KEY (an unclaimed key) or a saved session');
}
// A real deployment sees one client address, and /join is limited to 10 a minute
// per address (club.md §5-1); the fuller club stays under that.
const MEMBERS = live ? 9 : 20;

let origin;
let runtime;
let dispose = async () => {};
if (live) {
  origin = live;
  runtime = `against ${live}`;
} else {
  const { Miniflare, convertV4MiniflareOptions } = await import('miniflare');
  const { unstable_getMiniflareWorkerOptions } = await import('wrangler');
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
          bindings: {
            CLUB_SETUP_KEY: SETUP_KEY,
            CLUB_SECRET: 'measure-secret',
            CLUB_TEST_MODE: '1',
          },
        },
      ],
      durableObjectsPersist: persist,
    }),
  );
  origin = (await mf.ready).origin;
  runtime = `in workerd ${compatibilityDate} via Miniflare`;
  dispose = async () => {
    await mf.dispose();
    rmSync(persist, { recursive: true, force: true });
  };
}

const rows = [];
async function call(label, path, { method, token, body, ip } = {}) {
  const headers = {};
  if (token) headers.Authorization = `Bearer ${token}`;
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  // workerd passes a client-sent CF-Connecting-IP through, so locally this
  // gives each seeded member its own address. Cloudflare itself answers any
  // request that carries the header with its error 1000 ("DNS points to
  // prohibited IP"), so against a real deployment it is never sent.
  if (ip && !live) headers['CF-Connecting-IP'] = ip;
  const verb = method ?? (body === undefined ? 'GET' : 'POST');
  const startedAt = performance.now();
  const response = await fetch(`${origin}${path}`, {
    method: verb,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await response.text();
  const ms = Math.round(performance.now() - startedAt);
  const counted = /read=(\d+); written=(\d+)/.exec(response.headers.get('x-club-rows') ?? '');
  const isJson = (response.headers.get('content-type') ?? '').startsWith('application/json');
  const row = {
    label,
    request: `${verb} ${path.replace(/\/(c|m|ch|inv)_[A-Za-z0-9_-]+/g, '/:id')}`,
    status: response.status,
    read: counted ? Number(counted[1]) : NaN,
    written: counted ? Number(counted[2]) : NaN,
    bytes: new TextEncoder().encode(text).byteLength,
    ms,
    ray: response.headers.get('cf-ray'),
  };
  rows.push(row);
  if (text === '') return null;
  if (!isJson) {
    // Cloudflare answers some failures with its own HTML (a 1101 for a thrown
    // exception, a challenge page); keep what it said and carry on.
    row.snippet = text.replace(/\s+/g, ' ').slice(0, 300);
    return null;
  }
  return JSON.parse(text);
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

let firstPart = 0;
let seeded = [];
let resultCount = 0;
let fullPart = 0;

async function main() {
  // --- One club's life, request by request -------------------------------
  await call('health', '/api/v1/health');
  let owner;
  if (live && existsSync(SESSION_FILE)) {
    owner = JSON.parse(readFileSync(SESSION_FILE, 'utf8')).owner;
    console.log(`(no claim: continuing as the owner saved in ${SESSION_FILE})`);
  } else {
    owner = await call('claim', '/api/v1/claim', {
      body: { setupKey: SETUP_KEY, nickname: 'Yoh' },
    });
    if (!owner?.memberToken) throw new Error('claim did not return a member token');
    if (live) {
      mkdirSync(join(ROOT, 'data'), { recursive: true });
      writeFileSync(
        SESSION_FILE,
        JSON.stringify({ url: live, claimedAt: new Date().toISOString(), owner }, null, 2),
      );
    }
  }
  await call('health, claimed', '/api/v1/health');
  const invite = await call('read invite', '/api/v1/invite', { token: owner.memberToken });
  if (!invite?.token) throw new Error('GET /invite did not return a token');
  const member = await call('join', '/api/v1/join', {
    body: { inviteToken: invite.token, nickname: 'Ken' },
    ip: '203.0.113.10',
  });
  if (!member?.memberToken) throw new Error('join did not return a member token');
  await call('club (2 members)', '/api/v1/club', { token: member.memberToken });
  const challenge = await call('create challenge + result', '/api/v1/challenges', {
    token: owner.memberToken,
    body: challengeBody(`sudoku-free-${Date.now().toString(36)}`),
  });
  if (!challenge?.id) throw new Error('POST /challenges did not return a challenge');
  await call('list challenges (1)', '/api/v1/challenges', { token: member.memberToken });
  await call('one challenge', `/api/v1/challenges/${challenge.id}`, {
    token: member.memberToken,
  });
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
  firstPart = rows.length;

  // --- The same reads in a fuller club: MEMBERS members, 10 challenges ----
  const members = [owner, member];
  for (let i = members.length; i < MEMBERS; i++) {
    const joined = await call('(seed) join', '/api/v1/join', {
      body: { inviteToken: invite.token, nickname: `M${i}` },
      ip: `203.0.114.${i}`,
    });
    if (joined?.memberToken) members.push(joined);
  }
  const challenges = [challenge];
  for (let i = 1; i < 10; i++) {
    const created = await call('(seed) challenge', '/api/v1/challenges', {
      token: members[i % members.length].memberToken,
      body: challengeBody(`seed-${i}-${Date.now().toString(36)}`),
    });
    if (created?.id) challenges.push(created);
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
  seeded = rows.slice(firstPart);
  resultCount = seeded.filter((r) => r.label === '(seed) result' && r.status === 201).length + 2;
  fullPart = rows.length;
  await call(`club (${members.length} members)`, '/api/v1/club', { token: member.memberToken });
  await call('list challenges (10)', '/api/v1/challenges', { token: member.memberToken });
  await call(`results (${members.length})`, `/api/v1/challenges/${challenge.id}/results`, {
    token: owner.memberToken,
  });
  await call(`records (10 challenges, ${resultCount} results)`, '/api/v1/records', {
    token: owner.memberToken,
  });
}

const n = (value) => (Number.isNaN(value) ? '—' : String(value));
const sum = (list, key) => list.reduce((total, r) => total + r[key], 0);
const table = (list) => {
  console.log('| Step | Request | Status | Rows read | Rows written | Response bytes | ms |');
  console.log('| --- | --- | ---: | ---: | ---: | ---: | ---: |');
  for (const r of list) {
    console.log(
      `| ${r.label} | \`${r.request}\` | ${r.status} | ${n(r.read)} | ${n(r.written)} | ${r.bytes} | ${r.ms} |`,
    );
  }
};

function report() {
  console.log(`\nMeasured ${runtime}, ${new Date().toISOString().slice(0, 10)}.\n`);
  console.log('### One club, request by request\n');
  table(rows.slice(0, firstPart || rows.length));
  if (fullPart > firstPart) {
    console.log(
      `\n### The same reads with ${MEMBERS} members, 10 challenges, ${resultCount} results\n`,
    );
    table(rows.slice(fullPart));
    console.log(
      `\nSeeding the fuller club took ${seeded.length} requests, ${n(sum(seeded, 'read'))} rows read, ${n(sum(seeded, 'written'))} rows written, ${sum(seeded, 'ms')} ms in total.`,
    );
  }
  const okTimes = rows
    .filter((r) => r.status < 500)
    .map((r) => r.ms)
    .sort((a, b) => a - b);
  const median = okTimes[Math.floor(okTimes.length / 2)];
  console.log(
    `All told: ${rows.length} requests, ${rows.filter((r) => r.status >= 500).length} server errors, ${rows.filter((r) => r.status === 429).length} rate-limited, median ${median} ms.`,
  );
  const odd = rows.filter((r) => r.snippet !== undefined);
  if (odd.length > 0) {
    console.log('\nReplies that were not JSON:');
    for (const r of odd) {
      console.log(`- ${r.request} → ${r.status} (${r.ray ?? 'no cf-ray'}): ${r.snippet}`);
    }
  }
}

try {
  await main();
} finally {
  await dispose();
  report();
}
