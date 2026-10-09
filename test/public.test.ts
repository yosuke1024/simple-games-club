import { afterEach, describe, expect, it } from 'vitest';
import { claimOwner, startServer, type Session, type TestServer } from './helpers.js';

let server: TestServer;
afterEach(() => server.close());

let ipCounter = 0;
const joinOpen = async (nickname: string): Promise<Session> => {
  const reply = await server.api('/api/v1/join', {
    body: { nickname },
    headers: { 'X-Forwarded-For': `198.51.100.${++ipCounter}` },
  });
  if (reply.status !== 201) throw new Error(`join failed: ${reply.status} ${reply.text}`);
  return {
    token: reply.json.memberToken,
    memberId: reply.json.member.id,
    clubId: reply.json.club.id,
  };
};

const DAY = '2026-10-02';

const createDaily = (
  session: Session,
  gameId: string,
  seed: string,
  facts: Record<string, unknown>,
  daily: string | null = DAY,
) =>
  server.api('/api/v1/challenges', {
    token: session.token,
    body: {
      gameId,
      contractVersion: 1,
      params: {},
      seed,
      boardDigest: `dg:${seed}`,
      title: null,
      daily,
      result: { outcome: 'completed', facts },
    },
  });

const answer = (
  session: Session,
  challengeId: string,
  seed: string,
  facts: Record<string, unknown>,
  outcome = 'completed',
) =>
  server.api(`/api/v1/challenges/${challengeId}/results`, {
    token: session.token,
    body: { contractVersion: 1, boardDigest: `dg:${seed}`, outcome, facts },
  });

const offer = (
  session: Session,
  gameId: string,
  facts: Record<string, unknown>,
  paramsKey = 'default',
) =>
  server.api('/api/v1/rankings/results', {
    token: session.token,
    body: {
      gameId,
      contractVersion: 1,
      paramsKey,
      params: {},
      seed: '',
      boardDigest: null,
      outcome: 'completed',
      facts,
    },
  });

describe('GET /api/v1/public (club.md §18)', () => {
  it('is not found on a deployment that is not open', async () => {
    server = await startServer({ openJoin: false });
    await claimOwner(server, 'Yoh');
    const reply = await server.api('/api/v1/public');
    expect(reply.status).toBe(404);
    expect(reply.json.error.code).toBe('not_found');
  });

  it('lists the day top three by each game axis, the rankings leaders and the member count', async () => {
    server = await startServer({ openJoin: true });
    const yoh = await claimOwner(server, 'Yoh');
    const ken = await joinOpen('Ken');
    const mai = await joinOpen('Mai');
    const sam = await joinOpen('Sam');

    // sudoku: asc (lower seconds first). Yoh 300, Ken 250, Mai 400; Sam has only a played result, which is never ranked.
    const sudoku = await createDaily(yoh, 'sudoku', 's1', { elapsedSeconds: 300 });
    await answer(ken, sudoku.json.id, 's1', { elapsedSeconds: 250 });
    await answer(mai, sudoku.json.id, 's1', { elapsedSeconds: 400 });
    await answer(sam, sudoku.json.id, 's1', { elapsedSeconds: 10 }, 'played'); // not completed: never ranked
    // 2048: desc (higher score first).
    const game = await createDaily(yoh, '2048', 'g1', { score: 500 });
    await answer(ken, game.json.id, 'g1', { score: 2000 });
    await answer(mai, game.json.id, 'g1', { score: 1500 });
    await answer(sam, game.json.id, 'g1', { score: 900 });
    // A game the server has no contract for lists no top; another day's board is not today's.
    await createDaily(yoh, 'checkers', 'c1', { turns: 10 });
    await createDaily(yoh, 'sudoku', 's2', { elapsedSeconds: 1 }, '2026-10-01');
    await createDaily(yoh, 'sudoku', 's3', { elapsedSeconds: 1 }, null);

    await offer(ken, 'sudoku', { elapsedSeconds: 200 });
    await offer(mai, '2048', { score: 4096 });

    const reply = await server.api(`/api/v1/public?date=${DAY}`);
    expect(reply.status).toBe(200);
    expect(reply.headers.get('cache-control')).toBe('public, max-age=300');
    expect(reply.headers.get('x-club-api')).toBe('1');
    expect(reply.json).toEqual({
      club: { name: "Yoh's Club" },
      memberCount: 4,
      today: [
        {
          gameId: 'sudoku',
          daily: DAY,
          resultCount: 4,
          top: [
            { nickname: 'Ken', facts: { elapsedSeconds: 250 } },
            { nickname: 'Yoh', facts: { elapsedSeconds: 300 } },
            { nickname: 'Mai', facts: { elapsedSeconds: 400 } },
          ],
        },
        {
          gameId: '2048',
          daily: DAY,
          resultCount: 4,
          top: [
            { nickname: 'Ken', facts: { score: 2000 } },
            { nickname: 'Mai', facts: { score: 1500 } },
            { nickname: 'Sam', facts: { score: 900 } },
          ],
        },
        { gameId: 'checkers', daily: DAY, resultCount: 1, top: [] },
      ],
      rankings: [
        {
          gameId: '2048',
          paramsKey: 'default',
          entryCount: 1,
          leader: { nickname: 'Mai', facts: { score: 4096 } },
          top: [{ nickname: 'Mai', facts: { score: 4096 } }],
        },
        {
          gameId: 'sudoku',
          paramsKey: 'default',
          entryCount: 1,
          leader: { nickname: 'Ken', facts: { elapsedSeconds: 200 } },
          top: [{ nickname: 'Ken', facts: { elapsedSeconds: 200 } }],
        },
      ],
    });
    // Names and facts only: no member id leaves this response.
    expect(reply.text).not.toContain(ken.memberId);
  });

  it('defaults the date to the request clock and answers an empty day with empty lists', async () => {
    server = await startServer({ openJoin: true });
    const yoh = await claimOwner(server, 'Yoh');
    await createDaily(yoh, 'sudoku', 's1', { elapsedSeconds: 300 }, '2026-09-09');
    const today = await server.api('/api/v1/public'); // the test clock starts on 2026-09-09
    expect(today.json.today).toHaveLength(1);
    const other = await server.api('/api/v1/public?date=2026-01-01');
    expect(other.json.today).toEqual([]);
    expect(other.json.rankings).toEqual([]);
  });

  it('rejects a date that is not a calendar date', async () => {
    server = await startServer({ openJoin: true });
    await claimOwner(server, 'Yoh');
    for (const date of ['abc', '2026-13-40', '2026-02-30', '']) {
      expect((await server.api(`/api/v1/public?date=${date}`)).status, date).toBe(400);
    }
  });

  it('answers a second request from the cache on the Workers deployment only', async () => {
    server = await startServer({ openJoin: true });
    const yoh = await claimOwner(server, 'Yoh');
    await createDaily(yoh, 'sudoku', 's1', { elapsedSeconds: 300 });
    const first = await server.api(`/api/v1/public?date=${DAY}`);
    expect(first.json.today[0].resultCount).toBe(1);
    const ken = await joinOpen('Ken');
    const list = await server.api('/api/v1/challenges', { token: yoh.token });
    await answer(ken, list.json[0].id, 's1', { elapsedSeconds: 200 });
    const second = await server.api(`/api/v1/public?date=${DAY}`);
    // Workers: caches.default holds the first body for five minutes. Node sets the header only.
    const cached = process.env.CLUB_IMPL === 'workers';
    expect(second.json.today[0].resultCount).toBe(cached ? 1 : 2);
  });

  it('keys the cache by the resolved date: a request without one after midnight is not the first', async () => {
    server = await startServer({ openJoin: true });
    const yoh = await claimOwner(server, 'Yoh');
    await createDaily(yoh, 'sudoku', 's1', { elapsedSeconds: 300 }, '2026-09-09');
    await createDaily(yoh, 'hearts', 'h1', { score: 10 }, '2026-09-10');
    server.clock.now = new Date('2026-09-09T23:59:00.000Z');
    const first = await server.api('/api/v1/public');
    server.clock.now = new Date('2026-09-10T00:01:00.000Z');
    const second = await server.api('/api/v1/public');
    expect(first.json.today.map((t: { gameId: string }) => t.gameId)).toEqual(['sudoku']);
    expect(second.json.today.map((t: { gameId: string }) => t.gameId)).toEqual(['hearts']);
  });

  it('does not serve another object its cached body (Workers)', async () => {
    server = await startServer({ openJoin: true, objectName: 'club-a' });
    await claimOwner(server, 'Yoh');
    const first = await server.api(`/api/v1/public?date=${DAY}`);
    expect(first.status).toBe(200);
    await server.reopen({ objectName: 'club-b' });
    // A new, unclaimed object answers for itself (404), not with club-a's cached 200.
    const other = await server.api(`/api/v1/public?date=${DAY}`);
    expect(other.status).toBe(process.env.CLUB_IMPL === 'workers' ? 404 : 200);
  });
});

type PublicTable = {
  gameId: string;
  paramsKey: string;
  entryCount: number;
  leader: { nickname: string; facts: unknown };
  top: { nickname: string; facts: unknown }[];
};

/** `X-Club-Rows` — what the object read and wrote for a request; the Workers harness only (test mode). */
const rowsRead = (reply: { headers: Headers }): number | null => {
  const header = reply.headers.get('x-club-rows');
  const match = header === null ? null : /read=(\d+)/.exec(header);
  return match === null ? null : Number(match[1]);
};

describe('GET /api/v1/public rankings (club.md §18)', () => {
  it("lists each table's top three by the table's own order, ties by arrival, with the leader kept", async () => {
    server = await startServer({ openJoin: true });
    const yoh = await claimOwner(server, 'Yoh');
    const ken = await joinOpen('Ken');
    const mai = await joinOpen('Mai');
    const sam = await joinOpen('Sam');
    const lee = await joinOpen('Lee');

    // sudoku (lower is better): Mai 100 first, then Ken 120, and later a second row of Ken's that
    // ties her at 100 — one row per result, so Ken is in the table twice.
    await offer(mai, 'sudoku', { elapsedSeconds: 100 });
    await offer(ken, 'sudoku', { elapsedSeconds: 120 });
    await offer(sam, 'sudoku', { elapsedSeconds: 90 });
    await offer(yoh, 'sudoku', { elapsedSeconds: 500 });
    await offer(lee, 'sudoku', { elapsedSeconds: 700 });
    await offer(ken, 'sudoku', { elapsedSeconds: 100 }); // ties Mai's 100, but arrived after her
    // 2048 (higher is better), and hearts (lower is better) as the other direction.
    await offer(yoh, '2048', { score: 10 });
    await offer(ken, '2048', { score: 30 });
    await offer(mai, '2048', { score: 20 });
    await offer(sam, '2048', { score: 20 }); // ties Mai at 20, arrived later
    await offer(yoh, 'hearts', { score: 12 });
    await offer(ken, 'hearts', { score: 3 });
    await offer(ken, 'hearts', { score: 5 }); // the same name twice in a top three is not folded

    const reply = await server.api(`/api/v1/public?date=${DAY}`);
    const tables = reply.json.rankings as PublicTable[];
    expect(tables.map((t) => [t.gameId, t.entryCount])).toEqual([
      ['sudoku', 6],
      ['2048', 4],
      ['hearts', 3],
    ]);
    expect(tables[0]!.top).toEqual([
      { nickname: 'Sam', facts: { elapsedSeconds: 90 } },
      { nickname: 'Mai', facts: { elapsedSeconds: 100 } },
      { nickname: 'Ken', facts: { elapsedSeconds: 100 } },
    ]);
    expect(tables[1]!.top).toEqual([
      { nickname: 'Ken', facts: { score: 30 } },
      { nickname: 'Mai', facts: { score: 20 } },
      { nickname: 'Sam', facts: { score: 20 } },
    ]);
    expect(tables[2]!.top).toEqual([
      { nickname: 'Ken', facts: { score: 3 } },
      { nickname: 'Ken', facts: { score: 5 } },
      { nickname: 'Yoh', facts: { score: 12 } },
    ]);
    for (const table of tables) expect(table.leader).toEqual(table.top[0]);
    for (const member of [yoh, ken, mai, sam, lee]) {
      expect(reply.text).not.toContain(member.memberId);
    }
  });

  it('shows the eight most-entered tables, most first, ties by game then mode', async () => {
    server = await startServer({ openJoin: true });
    const yoh = await claimOwner(server, 'Yoh');
    const ken = await joinOpen('Ken');
    const mai = await joinOpen('Mai');
    const sam = await joinOpen('Sam');
    const everyone = [yoh, ken, mai, sam];

    // Entries per table: sudoku 4, 2048 3, hearts 3, four with 2, three with 1 — ten tables in all.
    const plan: [string, string, number][] = [
      ['sudoku', 'default', 4],
      ['2048', 'default', 3],
      ['hearts', 'default', 3],
      ['takuzu', 'default', 2],
      ['nonogram', 'default', 2],
      ['kakuro', 'default', 2],
      ['futoshiki', 'b-mode', 2],
      ['futoshiki', 'a-mode', 2], // same game as above: the mode breaks the tie
      ['crown-grid', 'default', 1],
      ['minesweeper', 'default', 1],
      ['yacht', 'default', 1],
    ];
    for (const [gameId, paramsKey, entries] of plan) {
      const facts =
        gameId === '2048' || gameId === 'hearts' || gameId === 'yacht' ? 'score' : 'elapsedSeconds';
      for (const [i, member] of everyone.slice(0, entries).entries()) {
        await offer(member, gameId, { [facts]: 100 + i }, paramsKey);
      }
    }
    const reply = await server.api(`/api/v1/public?date=${DAY}`);
    const tables = reply.json.rankings as PublicTable[];
    expect(tables).toHaveLength(8);
    expect(tables.map((t) => `${t.gameId}/${t.paramsKey}:${t.entryCount}`)).toEqual([
      'sudoku/default:4',
      '2048/default:3',
      'hearts/default:3',
      'futoshiki/a-mode:2',
      'futoshiki/b-mode:2',
      'kakuro/default:2',
      'nonogram/default:2',
      'takuzu/default:2',
    ]);
    // The cut falls on the count, not on the name: no table of one entry made it in.
    expect(tables.every((t) => t.entryCount >= 2)).toBe(true);
    for (const table of tables) {
      expect(table.top.length).toBeLessThanOrEqual(3);
      expect(table.top).toHaveLength(Math.min(3, table.entryCount));
    }
  });

  it('moves a table up when it gains entries, and a purged member takes theirs out of it', async () => {
    server = await startServer({ openJoin: true });
    const yoh = await claimOwner(server, 'Yoh');
    const ken = await joinOpen('Ken');
    await offer(yoh, 'sudoku', { elapsedSeconds: 100 });
    await offer(yoh, 'hearts', { score: 5 });
    await offer(ken, 'hearts', { score: 6 });
    // A fresh date each time: the Workers deployment caches a date's body for five minutes.
    let day = 0;
    const order = async () => {
      const reply = await server.api(
        `/api/v1/public?date=2026-03-${String(++day).padStart(2, '0')}`,
      );
      return (reply.json.rankings as PublicTable[]).map((t) => `${t.gameId}:${t.entryCount}`);
    };
    expect(await order()).toEqual(['hearts:2', 'sudoku:1']);
    await offer(ken, 'sudoku', { elapsedSeconds: 90 }); // sudoku 2: ties hearts, "hearts" < "sudoku"
    await offer(yoh, 'hearts', { score: 4 }); // a second row of Yoh's: every result counts
    expect(await order()).toEqual(['hearts:3', 'sudoku:2']);
    await server.api(`/api/v1/members/${ken.memberId}?purge=1`, {
      method: 'DELETE',
      token: yoh.token,
    });
    expect(await order()).toEqual(['hearts:2', 'sudoku:1']);
  });

  it('takes the top three of a higher-is-better table from above the cut, then the earliest tied at it', async () => {
    server = await startServer({
      openJoin: true,
      limits: { ipPerMinute: 100000, memberPerMinute: 100000 },
    });
    const yoh = await claimOwner(server, 'Yoh');
    const members = [];
    for (let i = 0; i < 6; i++) members.push(await joinOpen(`M${i}`));
    const top = async (date: string, gameId: string) =>
      ((await server.api(`/api/v1/public?date=${date}`)).json.rankings as PublicTable[])
        .find((t) => t.gameId === gameId)!
        .top.map((e) => e.nickname);

    // 50 above, four at 40 (M1..M4 in arrival order), one below: the cut is 40 and falls inside the tie.
    await offer(members[3]!, 'mancala', { score: 40 }); // arrives first, so it leads the tie
    await offer(members[0]!, 'mancala', { score: 50 });
    await offer(members[1]!, 'mancala', { score: 40 });
    await offer(members[2]!, 'mancala', { score: 40 });
    await offer(members[4]!, 'mancala', { score: 40 });
    await offer(members[5]!, 'mancala', { score: 10 });
    expect(await top('2026-02-01', 'mancala')).toEqual(['M0', 'M3', 'M1']);

    // Everything tied: the first three to arrive, however many follow.
    for (const member of [yoh, ...members]) await offer(member, 'reversi', { score: 30 });
    expect(await top('2026-02-02', 'reversi')).toEqual(['Yoh', 'M0', 'M1']);

    // Fewer than three entries: all of them, best first.
    await offer(yoh, 'dots-and-boxes', { score: 4 });
    await offer(members[0]!, 'dots-and-boxes', { score: 9 });
    expect(await top('2026-02-03', 'dots-and-boxes')).toEqual(['M0', 'Yoh']);
  });

  it('reads the same rows however many entries tie at the third place of a score table (Workers)', async () => {
    server = await startServer({
      openJoin: true,
      limits: { ipPerMinute: 100000, memberPerMinute: 100000 },
    });
    const yoh = await claimOwner(server, 'Yoh');
    const others = [];
    for (let i = 0; i < 20; i++) others.push(await joinOpen(`M${i}`));
    const read = async (date: string): Promise<number | null> =>
      rowsRead(await server.api(`/api/v1/public?date=${date}`));

    // Four entries, three of them tied at the cut …
    await offer(yoh, 'reversi', { score: 60 });
    for (const member of others.slice(0, 3)) await offer(member, 'reversi', { score: 40 });
    const few = await read('2026-03-01');
    // … and twenty-three, twenty-two tied at it.
    for (const member of others.slice(3)) await offer(member, 'reversi', { score: 40 });
    const many = await read('2026-03-02');
    if (few === null || many === null) return; // Node reports no rows
    expect(many).toBeLessThanOrEqual(few + 2);
  });

  it('reads a bounded number of rows however many tables and entries there are (Workers)', async () => {
    server = await startServer({
      openJoin: true,
      limits: { ipPerMinute: 100000, memberPerMinute: 100000 },
    });
    const yoh = await claimOwner(server, 'Yoh');
    const others = [];
    for (let i = 0; i < 12; i++) others.push(await joinOpen(`M${i}`));
    const read = async (date: string): Promise<number | null> =>
      rowsRead(await server.api(`/api/v1/public?date=${date}`));

    // Twelve tables of 1–2 entries.
    for (let t = 0; t < 12; t++) {
      await offer(yoh, 'sudoku', { elapsedSeconds: 100 + t }, `m${t}`);
      if (t % 2 === 0) await offer(others[0]!, 'sudoku', { elapsedSeconds: 200 + t }, `m${t}`);
    }
    const small = await read('2026-01-01');
    // Sixty more tables, and one table of thirteen entries.
    for (let t = 12; t < 72; t++) await offer(yoh, 'sudoku', { elapsedSeconds: 100 + t }, `m${t}`);
    // Distinct scores: a higher-is-better table reads the whole group tied at the cut (docs/cloudflare.md §3).
    for (const [i, member] of others.entries()) await offer(member, '2048', { score: 50 + i });
    await offer(yoh, '2048', { score: 99 });
    const large = await read('2026-01-02');
    if (small === null || large === null) return; // Node reports no rows
    // Eight tables are read either way: more tables and entries cost nothing more.
    expect(large).toBeLessThanOrEqual(small + 10);
    expect(large).toBeLessThan(80);
  });
});
