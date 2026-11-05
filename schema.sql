-- Titles we could resolve to a Stremio (Cinemeta) entry.
CREATE TABLE IF NOT EXISTS titles (
  imdb_id TEXT PRIMARY KEY,
  type TEXT NOT NULL,            -- movie | series
  name TEXT NOT NULL,
  year TEXT,
  poster TEXT
);

-- One row per (HN comment, title) mention.
CREATE TABLE IF NOT EXISTS mentions (
  comment_id INTEGER NOT NULL,
  imdb_id TEXT NOT NULL,
  author TEXT,
  created_at INTEGER NOT NULL,   -- unix seconds
  story_id INTEGER,
  source TEXT NOT NULL,          -- imdb | wikipedia | llm
  PRIMARY KEY (comment_id, imdb_id)
);
CREATE INDEX IF NOT EXISTS mentions_imdb ON mentions (imdb_id);
CREATE INDEX IF NOT EXISTS mentions_time ON mentions (created_at);

-- Cache of lookups (wikipedia page or "title|year|type" -> imdb id, '' when not found).
CREATE TABLE IF NOT EXISTS lookups (
  key TEXT PRIMARY KEY,
  imdb_id TEXT NOT NULL
);

-- Ingest cursors.
CREATE TABLE IF NOT EXISTS state (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

-- Comments already read (llm = 1 when the LLM pass ran on it too).
CREATE TABLE IF NOT EXISTS processed (
  comment_id INTEGER PRIMARY KEY,
  llm INTEGER NOT NULL DEFAULT 0
);
