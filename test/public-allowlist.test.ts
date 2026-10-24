/**
 * `GET /api/v1/public` lists only the club's enabled games, and applies that before its
 * limits: a busy disabled game must not push the enabled ones off the page (the endpoint
 * has no next page). Node only — this is the store's query, the same on both deployments.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { hashToken } from '../src/auth/tokens.js';
import { openDatabase, type NodeDatabase } from '../src/db/database.js';
import { Store } from '../src/db/store.js';
import { createApi } from '../src/http/api.js';
import { PUBLIC_TABLES } from '../src/api/public.js';

const NOW = '2026-10-24T00:00:00.000Z';
const DAY = NOW.slice(0, 10);
let db: NodeDatabase | null = null;
afterEach(() => {
  db?.close();
  db = null;
});

async function publicFeed(fill: (store: Store) => void, allowedGameIds = ['sudoku']) {
  db = openDatabase(':memory:');
  const store = new Store(db.driver);
  store.createClub('c_allowlist001', 'Allowlist', NOW);
  store.createMember('m_allowlist001', 'Owner', 'owner', hashToken('secret', 'token'), NOW);
  fill(store);
  store.policy.saveSettings({
    visibility: 'public',
    approvalRequired: false,
    allowedGameIds,
  });
  const api = createApi({
    store,
    config: {
      secret: 'secret',
      setupKey: null,
      corsOrigins: [],
      openJoin: true,
      hosting: { provider: null, manageUrl: null },
    },
  });
  const reply = await api.handle({
    method: 'GET',
    url: new URL(`https://club.example.test/api/v1/public?date=${DAY}`),
    origin: 'https://club.example.test',
    now: new Date(NOW),
    clientIp: '192.0.2.1',
    header: () => undefined,
    body: { contentType: undefined, contentLength: undefined, async *chunks() {} },
  });
  expect(reply.status).toBe(200);
  return JSON.parse(reply.body as string) as {
    today: { gameId: string }[];
    rankings: { gameId: string }[];
  };
}

const ranking = (gameId: string, paramsKey: string, value: number) => ({
  gameId,
  paramsKey,
  memberId: 'm_allowlist001',
  nickname: 'Owner',
  value,
  facts: { score: value },
  seed: '',
  boardDigest: null,
  now: NOW,
  rowsPerMember: 50,
});

describe.skipIf(process.env.CLUB_IMPL === 'workers')('GET /api/v1/public allowlist', () => {
  it('keeps an enabled table when more popular disabled tables fill the limit', async () => {
    const feed = await publicFeed((store) => {
      for (let i = 0; i < PUBLIC_TABLES; i++) {
        store.addRanking(ranking('2048', `mode${i}`, 100));
        store.addRanking(ranking('2048', `mode${i}`, 101));
      }
      store.addRanking(ranking('sudoku', 'hard', 300));
    });
    expect(feed.rankings.map((table) => table.gameId)).toEqual(['sudoku']);
  });

  it('keeps an enabled table however many disabled tables come before it', async () => {
    const feed = await publicFeed((store) => {
      for (let i = 0; i < 600; i++) {
        store.addRanking(ranking('2048', `mode${i}`, 100));
        store.addRanking(ranking('2048', `mode${i}`, 101));
      }
      store.addRanking(ranking('sudoku', 'hard', 300));
    });
    expect(feed.rankings.map((table) => table.gameId)).toEqual(['sudoku']);
  });

  it('merges the most-entered tables across a 128-game allowlist, in order', async () => {
    // More ids than one query binds: the busiest table sits in the second chunk.
    const ids = Array.from({ length: 128 }, (_, i) => `game-${String(i).padStart(3, '0')}`);
    const feed = await publicFeed((store) => {
      for (const [index, entries] of [
        [127, 3],
        [0, 2],
        [64, 1],
      ] as const) {
        for (let n = 0; n < entries; n++) store.addRanking(ranking(ids[index]!, 'mode', 100 + n));
      }
    }, ids);
    expect(feed.rankings.map((table) => table.gameId)).toEqual([ids[127], ids[0], ids[64]]);
  });

  it('reads nothing for an empty allowlist', async () => {
    const feed = await publicFeed((store) => {
      store.addRanking(ranking('sudoku', 'hard', 300));
    }, []);
    expect(feed.rankings).toEqual([]);
    expect(feed.today).toEqual([]);
  });

  it("keeps an enabled game's daily when disabled dailies fill the page", async () => {
    const feed = await publicFeed((store) => {
      // More disabled dailies than any page holds, then the enabled one.
      for (let i = 0; i < 60; i++) {
        store.createChallenge({
          id: `ch_disabled${String(i).padStart(3, '0')}`,
          gameId: '2048',
          contractVersion: 1,
          params: {},
          seed: `s${i}`,
          boardDigest: `d${i}`,
          title: null,
          daily: DAY,
          createdBy: 'm_allowlist001',
          now: NOW,
        });
      }
      store.createChallenge({
        id: 'ch_enabled0001',
        gameId: 'sudoku',
        contractVersion: 1,
        params: {},
        seed: 'sudoku-seed',
        boardDigest: 'sudoku-digest',
        title: null,
        daily: DAY,
        createdBy: 'm_allowlist001',
        now: NOW,
      });
    });
    expect(feed.today.map((challenge) => challenge.gameId)).toEqual(['sudoku']);
  });
});
