/** Owner summaries and member-readable record albums (managed-clubs.md §§2–3). */
import { newId } from '../auth/tokens.js';
import {
  MAX_ALBUM_ITEMS,
  MAX_ALBUMS,
  type AlbumSelection,
  type RecordAlbum,
  type TableKey,
} from '../db/ownerRecords.js';
import { invalidRequest, notFound, tooLarge } from '../http/errors.js';
import type { Router } from '../http/router.js';
import * as v from '../validate.js';
import { iso, type Deps } from './deps.js';
import { settingsOf } from './settings.js';
import { rankingEntryShape, resultShape } from './shape.js';

const albumShape = (album: RecordAlbum) => ({
  ...album,
  tables: album.tables.map((table) => ({ ...table, entry: rankingEntryShape(table.entry) })),
  daily: album.daily.map((board) => ({ ...board, entry: resultShape(board.entry) })),
});

function tableKey(value: unknown): TableKey {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw invalidRequest('a table must name gameId and paramsKey');
  }
  const row = value as Record<string, unknown>;
  return { gameId: v.gameId(row.gameId), paramsKey: v.paramsKey(row.paramsKey) };
}

function afterKey(value: string | null): TableKey | null {
  if (value === null) return null;
  const parts = value.split(':');
  if (parts.length !== 2) throw invalidRequest('after must be gameId:paramsKey');
  return { gameId: v.gameId(parts[0]), paramsKey: v.paramsKey(parts[1]) };
}

export function registerOwnerRecords(router: Router, deps: Deps): void {
  const { store } = deps;
  const records = store.ownerRecords;

  router.add('GET', '/api/v1/owner/records', { auth: 'owner', limit: 'member' }, (ctx) => {
    const club = store.getClub();
    if (club === null) throw notFound('this server has not been claimed yet');
    const limit = v.top(ctx.query.get('limit'), 25, 50);
    const after = afterKey(ctx.query.get('after'));
    const day = ctx.query.has('daily') ? v.dailyQuery(ctx.query.get('daily')) : null;
    const dailyAfter = ctx.query.get('dailyAfter');
    if (dailyAfter !== null && day === null) throw invalidRequest('dailyAfter requires daily');
    const dailyCursor =
      dailyAfter === null || day === null ? 0 : records.dailyCursor(dailyAfter, day);
    if (dailyCursor === null) throw invalidRequest('dailyAfter must be a challenge of that day');
    const allowed = settingsOf(deps).allowedGameIds;
    const tables = records.tablePage(ctx.member!.id, allowed, after, limit);
    const daily =
      day === null
        ? { daily: [], nextDailyAfter: null }
        : records.dailyPage(ctx.member!.id, allowed, day, dailyCursor, limit);
    return {
      status: 200,
      body: {
        club: { id: club.id, name: club.name },
        generatedAt: iso(ctx.now),
        memberCount: store.countActive(),
        basis: 'retained-member-bests',
        ...tables,
        tables: tables.tables.map((table) => ({
          ...table,
          leader: table.leader === null ? null : rankingEntryShape(table.leader),
          me:
            table.me === null
              ? null
              : { rank: table.me.rank, entry: rankingEntryShape(table.me.entry) },
        })),
        ...daily,
        daily: daily.daily.map((board) => ({
          ...board,
          leader: board.leader === null ? null : resultShape(board.leader),
          me:
            board.me === null ? null : { rank: board.me.rank, entry: resultShape(board.me.entry) },
        })),
      },
    };
  });

  router.add('GET', '/api/v1/albums', { auth: 'member', limit: 'member' }, () => ({
    status: 200,
    body: { albums: records.albums() },
  }));

  router.add('GET', '/api/v1/albums/:id', { auth: 'member', limit: 'member' }, (ctx) => {
    const album = records.album(ctx.params.id!, settingsOf(deps).allowedGameIds);
    if (album === null) throw notFound('no such album');
    return { status: 200, body: albumShape(album) };
  });

  router.add('POST', '/api/v1/albums', { auth: 'owner', limit: 'member' }, async (ctx) => {
    const body = await ctx.body();
    const title = v.title(body.title);
    if (title === null || title === '') throw invalidRequest('title must be 1..60 characters');
    const clientId = v.clientIdOrNull(body.clientId);
    if (!Array.isArray(body.tables)) throw invalidRequest('tables must be an array');
    const challengeIds = body.challengeIds ?? [];
    if (!Array.isArray(challengeIds)) throw invalidRequest('challengeIds must be an array');
    if (body.tables.length + challengeIds.length < 1) {
      throw invalidRequest('select at least one table or daily board');
    }
    if (body.tables.length + challengeIds.length > MAX_ALBUM_ITEMS) {
      throw tooLarge(`select at most ${MAX_ALBUM_ITEMS} tables and daily boards`);
    }
    const keys = body.tables.map(tableKey);
    const ids = challengeIds.map((id) => v.secretField(id, 'challengeId'));
    if (
      new Set(keys.map((key) => `${key.gameId}:${key.paramsKey}`)).size !== keys.length ||
      new Set(ids).size !== ids.length
    ) {
      throw invalidRequest('an album cannot contain duplicate selections');
    }
    const allowed = settingsOf(deps).allowedGameIds;
    const existingId = clientId === null ? null : records.albumIdForClient(clientId);
    if (existingId !== null) {
      return { status: 200, body: albumShape(records.album(existingId, allowed)!) };
    }
    if (records.albumCount() >= MAX_ALBUMS) {
      throw tooLarge(`a club keeps at most ${MAX_ALBUMS} albums; delete one before publishing`);
    }
    const selection: AlbumSelection = { tables: [], daily: [] };
    for (const key of keys) {
      if (allowed !== null && !allowed.includes(key.gameId)) {
        throw invalidRequest('the club does not include a selected game');
      }
      const ref = records.tableReference(key);
      if (ref === null)
        throw invalidRequest('a selected table has no retained active-member record');
      selection.tables.push(ref);
    }
    for (const id of ids) {
      const ref = records.dailyReference(id);
      if (ref === null) throw invalidRequest('a selected daily board has no available record');
      if (allowed !== null && !allowed.includes(ref.gameId)) {
        throw invalidRequest('the club does not include a selected game');
      }
      selection.daily.push({ challengeId: ref.challengeId, seq: ref.seq });
    }
    const id = newId('album');
    const now = iso(ctx.now);
    records.createAlbum({ id, title, now, clientId, selection });
    store.touchActivity(now);
    return { status: 201, body: albumShape(records.album(id, allowed)!) };
  });

  router.add('DELETE', '/api/v1/albums/:id', { auth: 'owner', limit: 'member' }, (ctx) => {
    if (!records.deleteAlbum(ctx.params.id!)) throw notFound('no such album');
    store.touchActivity(iso(ctx.now));
    return { status: 204 };
  });
}
