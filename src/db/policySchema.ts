/** Admission and game selection belong to a club, not to a deployment. */
export const POLICY_SQL = `
CREATE TABLE IF NOT EXISTS club_settings (
  singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
  visibility TEXT NOT NULL CHECK (visibility IN ('public', 'private')),
  approval_required INTEGER NOT NULL CHECK (approval_required IN (0, 1)),
  allowed_game_ids_json TEXT
);

CREATE TABLE IF NOT EXISTS join_requests (
  seq INTEGER PRIMARY KEY AUTOINCREMENT,
  id TEXT NOT NULL UNIQUE,
  nickname TEXT NOT NULL,
  token_hash TEXT NOT NULL UNIQUE,
  member_id TEXT NOT NULL UNIQUE,
  status TEXT NOT NULL CHECK (status IN ('pending', 'approved', 'rejected', 'cancelled', 'expired')),
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  decided_at TEXT
);
CREATE INDEX IF NOT EXISTS join_requests_status
  ON join_requests (status, seq);

CREATE INDEX IF NOT EXISTS challenges_game_seq
  ON challenges (game_id, seq DESC);
`;
