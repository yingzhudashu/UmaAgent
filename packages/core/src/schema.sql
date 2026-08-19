PRAGMA foreign_keys = ON;
PRAGMA journal_mode = WAL;

CREATE TABLE sessions (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  workspace TEXT NOT NULL,
  model_provider TEXT NOT NULL,
  model_id TEXT NOT NULL,
  thinking_level TEXT NOT NULL,
  revision INTEGER NOT NULL DEFAULT 0,
  next_sequence INTEGER NOT NULL DEFAULT 1,
  next_event_sequence INTEGER NOT NULL DEFAULT 1,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE runs (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  message_id TEXT NOT NULL UNIQUE,
  status TEXT NOT NULL,
  route TEXT,
  reasoning_summary TEXT,
  error TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX runs_session_created ON runs(session_id, created_at DESC);

CREATE TABLE plan_steps (
  id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
  position INTEGER NOT NULL,
  title TEXT NOT NULL,
  status TEXT NOT NULL
);
CREATE UNIQUE INDEX plan_steps_position ON plan_steps(run_id, position);

CREATE TABLE attachments (
  id TEXT PRIMARY KEY,
  session_id TEXT REFERENCES sessions(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  mime_type TEXT NOT NULL,
  size INTEGER NOT NULL,
  storage_path TEXT NOT NULL,
  created_at INTEGER NOT NULL
);

CREATE TABLE messages (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  run_id TEXT REFERENCES runs(id) ON DELETE SET NULL,
  sequence INTEGER NOT NULL,
  role TEXT NOT NULL,
  status TEXT NOT NULL,
  name TEXT,
  content TEXT NOT NULL,
  payload_json TEXT,
  attachment_ids_json TEXT NOT NULL DEFAULT '[]',
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  UNIQUE(session_id, sequence)
);
CREATE INDEX messages_session_sequence ON messages(session_id, sequence);

CREATE TABLE tool_calls (
  id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  input_json TEXT NOT NULL,
  result_json TEXT,
  status TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE approvals (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  run_id TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
  tool_call_id TEXT NOT NULL,
  tool_name TEXT NOT NULL,
  input_json TEXT NOT NULL,
  status TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  resolved_at INTEGER
);
CREATE INDEX approvals_pending ON approvals(status, created_at);

CREATE TABLE memory_items (
  id TEXT PRIMARY KEY,
  session_id TEXT REFERENCES sessions(id) ON DELETE CASCADE,
  scope TEXT NOT NULL,
  content TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE VIRTUAL TABLE memory_fts USING fts5(id UNINDEXED, content, tokenize='trigram');

CREATE TABLE context_summaries (
  session_id TEXT PRIMARY KEY REFERENCES sessions(id) ON DELETE CASCADE,
  through_sequence INTEGER NOT NULL,
  content TEXT NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE knowledge_sources (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  path TEXT NOT NULL UNIQUE,
  document_count INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL
);
CREATE TABLE knowledge_chunks (
  id TEXT PRIMARY KEY,
  source_id TEXT NOT NULL REFERENCES knowledge_sources(id) ON DELETE CASCADE,
  file_path TEXT NOT NULL,
  position INTEGER NOT NULL,
  content TEXT NOT NULL
);
CREATE VIRTUAL TABLE knowledge_fts USING fts5(id UNINDEXED, source_id UNINDEXED, file_path UNINDEXED, content, tokenize='trigram');

CREATE TABLE web_sessions (
  id_hash TEXT PRIMARY KEY,
  expires_at INTEGER NOT NULL,
  created_at INTEGER NOT NULL
);

PRAGMA user_version = 2;
