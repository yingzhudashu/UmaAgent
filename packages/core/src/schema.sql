PRAGMA foreign_keys = ON;
PRAGMA journal_mode = WAL;

CREATE TABLE sessions (
  id TEXT PRIMARY KEY,
  mode TEXT NOT NULL CHECK (mode IN ('workspace','assistant')),
  title TEXT NOT NULL,
  workspace TEXT,
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
  clarification_count INTEGER NOT NULL DEFAULT 0,
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
  ,started_at INTEGER
  ,completed_at INTEGER
  ,error TEXT
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
  source_json TEXT,
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

CREATE TABLE memory_facts (
  id TEXT PRIMARY KEY,
  session_id TEXT REFERENCES sessions(id) ON DELETE CASCADE,
  scope TEXT NOT NULL CHECK (scope IN ('global','session')),
  content TEXT NOT NULL,
  confidence REAL NOT NULL,
  source_run_id TEXT REFERENCES runs(id) ON DELETE SET NULL,
  status TEXT NOT NULL CHECK (status IN ('active','candidate','rejected')),
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX memory_facts_scope_status ON memory_facts(scope,status,updated_at DESC);

CREATE TABLE background_tasks (
  id TEXT PRIMARY KEY,
  parent_session_id TEXT REFERENCES sessions(id) ON DELETE SET NULL,
  session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  prompt TEXT NOT NULL,
  status TEXT NOT NULL,
  result TEXT,
  error TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX background_tasks_updated ON background_tasks(updated_at DESC);

CREATE TABLE audit_events (
  id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
  kind TEXT NOT NULL,
  name TEXT NOT NULL,
  input_json TEXT,
  output_json TEXT,
  status TEXT NOT NULL,
  duration_ms INTEGER,
  usage_json TEXT,
  error TEXT,
  created_at INTEGER NOT NULL
);
CREATE INDEX audit_events_run_created ON audit_events(run_id,created_at);

CREATE TABLE model_calls (
  id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
  provider TEXT NOT NULL,
  model TEXT NOT NULL,
  role TEXT NOT NULL,
  status TEXT NOT NULL,
  duration_ms INTEGER,
  usage_json TEXT,
  error TEXT,
  created_at INTEGER NOT NULL
);
CREATE INDEX model_calls_run_created ON model_calls(run_id,created_at);

CREATE TABLE session_events (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  run_id TEXT REFERENCES runs(id) ON DELETE CASCADE,
  sequence INTEGER NOT NULL,
  protocol_version INTEGER NOT NULL,
  type TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  UNIQUE(session_id, sequence)
);
CREATE INDEX session_events_session_sequence ON session_events(session_id, sequence);

CREATE TABLE run_checkpoints (
  id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
  checkpoint_no INTEGER NOT NULL,
  phase TEXT NOT NULL,
  plan_step_id TEXT REFERENCES plan_steps(id) ON DELETE SET NULL,
  turn_count INTEGER NOT NULL,
  last_message_sequence INTEGER NOT NULL,
  context_summary_sequence INTEGER,
  safe_to_resume INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  UNIQUE(run_id, checkpoint_no)
);
CREATE INDEX run_checkpoints_run_created ON run_checkpoints(run_id, checkpoint_no DESC);

CREATE TABLE run_actions (
  id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
  checkpoint_id TEXT REFERENCES run_checkpoints(id) ON DELETE SET NULL,
  tool_call_id TEXT NOT NULL,
  tool_name TEXT NOT NULL,
  tool_class TEXT NOT NULL,
  idempotency_key TEXT NOT NULL UNIQUE,
  input_json TEXT,
  result_json TEXT,
  status TEXT NOT NULL,
  started_at INTEGER,
  completed_at INTEGER,
  error TEXT
);
CREATE INDEX run_actions_run_status ON run_actions(run_id, status);

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

PRAGMA user_version = 4;
