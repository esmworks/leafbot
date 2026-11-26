-- Tables of the names service (src/d1-store.ts). Applied with:
--   pnpm dlx wrangler d1 execute leafbot-names --remote --file schema.sql
-- Safe to run again: nothing is dropped.

CREATE TABLE IF NOT EXISTS names (
  label TEXT PRIMARY KEY,
  -- Not unique: a server set up again on the same address gets a new name while the old one, whose
  -- token may be with nobody now, expires by itself.
  ip TEXT NOT NULL,
  record_id TEXT NOT NULL,
  -- SHA-256 of the server's token; the token itself is only ever with the server.
  token_hash TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  seen_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS names_seen_at ON names (seen_at);
CREATE INDEX IF NOT EXISTS names_ip ON names (ip, seen_at);

-- Every name handed out, kept for eight days for the per-address and weekly limits. Names given up
-- or expired still count, because their certificates did.
CREATE TABLE IF NOT EXISTS claims (
  ip TEXT NOT NULL,
  at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS claims_at ON claims (at);
CREATE INDEX IF NOT EXISTS claims_ip_at ON claims (ip, at);
