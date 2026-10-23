/**
 * Current member-best summaries and owner-selected record albums. These are views
 * of records that the club already holds, not counters of plays or device activity.
 */
import { contractOf } from '../contracts/games.js';
import type { Row, SqlDriver, SqlValue } from './driver.js';
import type { RankingEntryRow, ResultRow } from './store.js';

export const MAX_ALBUMS = 24;
export const MAX_ALBUM_ITEMS = 50;

export interface TableKey {
  gameId: string;
  paramsKey: string;
}

interface Axis {
  fact: string;
  direction: 'asc' | 'desc';
}

export interface OwnerRecordTable extends TableKey {
  participantCount: number;
  axis: Axis;
  leader: RankingEntryRow | null;
  medianBestValue: number | null;
  me: { rank: number; entry: RankingEntryRow } | null;
}

export interface DailyBoard {
  challengeId: string;
  gameId: string;
  contractVersion: number;
  params: unknown;
  seed: string;
  boardDigest: string;
  daily: string;
}

export interface OwnerDailyRecord extends DailyBoard {
  participantCount: number;
  axis: Axis | null;
  leader: ResultRow | null;
  me: { rank: number; entry: ResultRow } | null;
}

interface TableReference extends TableKey {
  seq: number;
}

interface DailyReference {
  challengeId: string;
  seq: number;
}

export interface AlbumSelection {
  tables: TableReference[];
  daily: DailyReference[];
}

export interface AlbumSummary {
  id: string;
  title: string;
  createdAt: string;
  itemCount: number;
}

export interface RecordAlbum extends AlbumSummary {
  tables: (TableKey & { entry: RankingEntryRow })[];
  daily: (DailyBoard & { entry: ResultRow })[];
  unavailableCount: number;
}

const number = (row: Row, key: string) => Number(row[key]);
const text = (row: Row, key: string) => String(row[key]);

const rankingEntry = (row: Row): RankingEntryRow => ({
  seq: number(row, 'seq'),
  memberId: text(row, 'member_id'),
  nickname: text(row, 'nickname'),
  submittedAt: text(row, 'submitted_at'),
  facts: JSON.parse(text(row, 'facts_json')) as unknown,
  seed: text(row, 'seed'),
  boardDigest: row.board_digest === null ? null : text(row, 'board_digest'),
  value: number(row, 'value'),
});

const result = (row: Row): ResultRow => ({
  challengeId: text(row, 'challenge_id'),
  memberId: text(row, 'member_id'),
  nickname: text(row, 'nickname'),
  submittedAt: text(row, 'submitted_at'),
  outcome: row.outcome === 'completed' ? 'completed' : 'played',
  facts: JSON.parse(text(row, 'facts_json')) as unknown,
});

const dailyBoard = (row: Row): DailyBoard => ({
  challengeId: text(row, 'id'),
  gameId: text(row, 'game_id'),
  contractVersion: number(row, 'contract_version'),
  params: JSON.parse(text(row, 'params_json')) as unknown,
  seed: text(row, 'seed'),
  boardDigest: text(row, 'board_digest'),
  daily: text(row, 'daily'),
});

const selectionOf = (row: Row): AlbumSelection =>
  JSON.parse(text(row, 'selection_json')) as AlbumSelection;

const summaryOf = (row: Row): AlbumSummary => {
  const selection = selectionOf(row);
  return {
    id: text(row, 'id'),
    title: text(row, 'title'),
    createdAt: text(row, 'created_at'),
    itemCount: selection.tables.length + selection.daily.length,
  };
};

/** One JSON binding also works for a 128-game allowlist within SQLite's binding limit. */
function gameClause(
  allowed: readonly string[] | null,
  alias = '',
): {
  sql: string;
  values: SqlValue[];
} {
  return allowed === null
    ? { sql: '', values: [] }
    : {
        sql: ` AND ${alias}game_id IN (SELECT value FROM json_each(?))`,
        values: [JSON.stringify(allowed)],
      };
}

export class OwnerRecordStore {
  constructor(private readonly db: SqlDriver) {}

  tablePage(
    memberId: string,
    allowed: readonly string[] | null,
    after: TableKey | null,
    limit: number,
  ): { tables: OwnerRecordTable[]; nextAfter: string | null } {
    const games = gameClause(allowed);
    const keys = this.db.all(
      `SELECT game_id, params_key FROM ranking_tables
       WHERE (game_id, params_key) > (?, ?)${games.sql}
       ORDER BY game_id, params_key LIMIT ?`,
      after?.gameId ?? '',
      after?.paramsKey ?? '',
      ...games.values,
      limit + 1,
    );
    const page = keys.slice(0, limit);
    const tables = page.flatMap((row) => {
      const table = this.tableSummary(text(row, 'game_id'), text(row, 'params_key'), memberId);
      return table === null ? [] : [table];
    });
    const last = page.at(-1);
    return {
      tables,
      nextAfter:
        keys.length > limit && last !== undefined
          ? `${text(last, 'game_id')}:${text(last, 'params_key')}`
          : null,
    };
  }

  private tableSummary(
    gameId: string,
    paramsKey: string,
    memberId: string,
  ): OwnerRecordTable | null {
    const contract = contractOf(gameId);
    if (contract === undefined) return null;
    const ascending = contract.direction === 'asc';
    // Each member gets exactly one vote in the median and in this standing. The
    // oldest equally good row is that member's best, matching ordinary rankings.
    const entries = this.db
      .all(
        `WITH best_values AS (
           SELECT e.member_id, ${ascending ? 'MIN' : 'MAX'}(e.value) AS value
           FROM ranking_entries e JOIN members m ON m.id = e.member_id
           WHERE e.game_id = ? AND e.params_key = ? AND m.revoked_at IS NULL
           GROUP BY e.member_id
         ), best_rows AS (
           SELECT MIN(e.seq) AS seq FROM best_values b
           JOIN ranking_entries e ON e.member_id = b.member_id AND e.value = b.value
           WHERE e.game_id = ? AND e.params_key = ? GROUP BY e.member_id
         )
         SELECT e.* FROM ranking_entries e JOIN best_rows b ON b.seq = e.seq
         ORDER BY e.value ${ascending ? 'ASC' : 'DESC'}, e.seq ASC`,
        gameId,
        paramsKey,
        gameId,
        paramsKey,
      )
      .map(rankingEntry);
    const middle = Math.floor(entries.length / 2);
    const median = entries[middle];
    const myIndex = entries.findIndex((entry) => entry.memberId === memberId);
    return {
      gameId,
      paramsKey,
      participantCount: entries.length,
      axis: { fact: contract.order, direction: contract.direction },
      leader: entries[0] ?? null,
      medianBestValue:
        median === undefined
          ? null
          : entries.length % 2 === 1
            ? median.value
            : median.value / 2 + entries[middle - 1]!.value / 2,
      me: myIndex < 0 ? null : { rank: myIndex + 1, entry: entries[myIndex]! },
    };
  }

  /** A deleted board remains a usable page cursor; a different day's does not. */
  dailyCursor(id: string, day: string): number | null {
    const row = this.db.get(`SELECT seq FROM challenges WHERE id = ? AND daily = ?`, id, day);
    return row === undefined ? null : number(row, 'seq');
  }

  dailyPage(
    memberId: string,
    allowed: readonly string[] | null,
    day: string,
    after: number,
    limit: number,
  ): { daily: OwnerDailyRecord[]; nextDailyAfter: string | null } {
    const games = gameClause(allowed);
    const rows = this.db.all(
      `SELECT * FROM challenges WHERE daily = ? AND deleted_at IS NULL AND seq > ?${games.sql}
       ORDER BY seq LIMIT ?`,
      day,
      after,
      ...games.values,
      limit + 1,
    );
    const page = rows.slice(0, limit);
    const daily = page.map((row): OwnerDailyRecord => {
      const board = dailyBoard(row);
      const contract = contractOf(board.gameId);
      const entries = this.db
        .all(
          `SELECT r.* FROM results r JOIN members m ON m.id = r.member_id
           WHERE r.challenge_id = ? AND m.revoked_at IS NULL
           ORDER BY r.rank_class, r.rank_key, r.seq`,
          board.challengeId,
        )
        .map(result);
      const myIndex = entries.findIndex((entry) => entry.memberId === memberId);
      return {
        ...board,
        participantCount: entries.length,
        axis:
          contract === undefined ? null : { fact: contract.order, direction: contract.direction },
        leader: entries[0] ?? null,
        me: myIndex < 0 ? null : { rank: myIndex + 1, entry: entries[myIndex]! },
      };
    });
    const last = page.at(-1);
    return {
      daily,
      nextDailyAfter: rows.length > limit && last !== undefined ? text(last, 'id') : null,
    };
  }

  albumCount(): number {
    return number(this.db.get(`SELECT COUNT(*) AS n FROM owner_albums`)!, 'n');
  }

  albums(): AlbumSummary[] {
    return this.db
      .all(`SELECT * FROM owner_albums ORDER BY seq DESC LIMIT ?`, MAX_ALBUMS)
      .map(summaryOf);
  }

  albumIdForClient(clientId: string): string | null {
    const row = this.db.get(`SELECT id FROM owner_albums WHERE client_id = ?`, clientId);
    return row === undefined ? null : text(row, 'id');
  }

  /** Current best active member's source row. No copied facts enter the album table. */
  tableReference(key: TableKey): TableReference | null {
    const contract = contractOf(key.gameId);
    if (contract === undefined) return null;
    const row = this.db.get(
      `SELECT e.seq FROM ranking_entries e JOIN members m ON m.id = e.member_id
       WHERE e.game_id = ? AND e.params_key = ? AND m.revoked_at IS NULL
       ORDER BY e.value ${contract.direction === 'asc' ? 'ASC' : 'DESC'}, e.seq ASC LIMIT 1`,
      key.gameId,
      key.paramsKey,
    );
    return row === undefined ? null : { ...key, seq: number(row, 'seq') };
  }

  dailyReference(id: string): (DailyReference & { gameId: string }) | null {
    const row = this.db.get(
      `SELECT r.seq, c.game_id FROM challenges c
       JOIN results r ON r.challenge_id = c.id JOIN members m ON m.id = r.member_id
       WHERE c.id = ? AND c.daily IS NOT NULL AND c.deleted_at IS NULL AND m.revoked_at IS NULL
       ORDER BY r.rank_class, r.rank_key, r.seq LIMIT 1`,
      id,
    );
    return row === undefined
      ? null
      : { challengeId: id, seq: number(row, 'seq'), gameId: text(row, 'game_id') };
  }

  createAlbum(input: {
    id: string;
    title: string;
    now: string;
    clientId: string | null;
    selection: AlbumSelection;
  }): void {
    this.db.run(
      `INSERT INTO owner_albums (id, title, created_at, client_id, selection_json)
       VALUES (?, ?, ?, ?, ?)`,
      input.id,
      input.title,
      input.now,
      input.clientId,
      JSON.stringify(input.selection),
    );
  }

  album(id: string, allowed: readonly string[] | null): RecordAlbum | null {
    const row = this.db.get(`SELECT * FROM owner_albums WHERE id = ?`, id);
    if (row === undefined) return null;
    const selection = selectionOf(row);
    const tables: RecordAlbum['tables'] = [];
    const daily: RecordAlbum['daily'] = [];
    for (const ref of selection.tables) {
      if (allowed !== null && !allowed.includes(ref.gameId)) continue;
      const source = this.db.get(
        `SELECT e.* FROM ranking_entries e JOIN members m ON m.id = e.member_id
         WHERE e.seq = ? AND e.game_id = ? AND e.params_key = ? AND m.revoked_at IS NULL`,
        ref.seq,
        ref.gameId,
        ref.paramsKey,
      );
      if (source !== undefined) {
        tables.push({ gameId: ref.gameId, paramsKey: ref.paramsKey, entry: rankingEntry(source) });
      }
    }
    for (const ref of selection.daily) {
      const board = this.db.get(
        `SELECT * FROM challenges WHERE id = ? AND daily IS NOT NULL AND deleted_at IS NULL`,
        ref.challengeId,
      );
      if (board === undefined || (allowed !== null && !allowed.includes(text(board, 'game_id')))) {
        continue;
      }
      const source = this.db.get(
        `SELECT r.* FROM results r JOIN members m ON m.id = r.member_id
         WHERE r.seq = ? AND r.challenge_id = ? AND m.revoked_at IS NULL`,
        ref.seq,
        ref.challengeId,
      );
      if (source !== undefined) daily.push({ ...dailyBoard(board), entry: result(source) });
    }
    const summary = summaryOf(row);
    return {
      ...summary,
      tables,
      daily,
      unavailableCount: summary.itemCount - tables.length - daily.length,
    };
  }

  deleteAlbum(id: string): boolean {
    if (this.db.get(`SELECT id FROM owner_albums WHERE id = ?`, id) === undefined) return false;
    this.db.run(`DELETE FROM owner_albums WHERE id = ?`, id);
    return true;
  }
}
