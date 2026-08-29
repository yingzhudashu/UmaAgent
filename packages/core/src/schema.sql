PRAGMA foreign_keys = ON;
PRAGMA journal_mode = WAL;

CREATE TABLE users (
  id TEXT PRIMARY KEY,
  role TEXT NOT NULL CHECK (role IN ('admin','user')),
  status TEXT NOT NULL CHECK (status IN ('active','disabled')),
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  last_login_at INTEGER
);
CREATE INDEX users_status_created ON users(status, created_at);
INSERT INTO users(id,role,status,created_at,updated_at) VALUES('system','admin','active',0,0);

CREATE TABLE auth_tokens (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token_hash TEXT NOT NULL UNIQUE,
  label TEXT NOT NULL,
  scopes_json TEXT NOT NULL DEFAULT '["user"]',
  expires_at INTEGER,
  revoked_at INTEGER,
  created_at INTEGER NOT NULL,
  last_used_at INTEGER
);
CREATE INDEX auth_tokens_user_active ON auth_tokens(user_id, revoked_at, expires_at);

CREATE TABLE sessions (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  title TEXT NOT NULL,
  assistant_name TEXT NOT NULL DEFAULT 'UmaAgent',
  assistant_avatar_attachment_id TEXT REFERENCES attachments(id) ON DELETE SET NULL,
  workspace TEXT,
  model_provider TEXT NOT NULL,
  model_id TEXT NOT NULL,
  thinking_level TEXT NOT NULL,
  queue_mode TEXT NOT NULL DEFAULT 'queue' CHECK (queue_mode IN ('queue','preemptive')),
  active_branch_id TEXT,
  next_sequence INTEGER NOT NULL DEFAULT 1,
  next_event_sequence INTEGER NOT NULL DEFAULT 1,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE runs (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  message_id TEXT NOT NULL UNIQUE,
  target_message_id TEXT REFERENCES messages(id) ON DELETE SET NULL,
  result_message_id TEXT REFERENCES messages(id) ON DELETE SET NULL,
  queue_position INTEGER,
  interaction_mode TEXT NOT NULL CHECK (interaction_mode IN ('plan','agent')),
  kind TEXT NOT NULL DEFAULT 'agent' CHECK (kind IN ('agent','review','improve','command')),
  status TEXT NOT NULL,
  phase TEXT NOT NULL,
  task_class TEXT,
  goal TEXT,
  success_criteria_json TEXT NOT NULL DEFAULT '[]',
  assumptions_json TEXT NOT NULL DEFAULT '[]',
  model_snapshot_json TEXT NOT NULL,
  thinking_level TEXT NOT NULL,
  turn_count INTEGER NOT NULL DEFAULT 0,
  correction_count INTEGER NOT NULL DEFAULT 0 CHECK (correction_count IN (0,1)),
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
  status TEXT NOT NULL,
  started_at INTEGER,
  completed_at INTEGER,
  error TEXT,
  UNIQUE(run_id, position)
);

CREATE TABLE attachments (
  id TEXT PRIMARY KEY,
  session_id TEXT REFERENCES sessions(id) ON DELETE CASCADE,
  response_id TEXT,
  owner_user_id TEXT REFERENCES users(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  mime_type TEXT NOT NULL,
  size INTEGER NOT NULL,
  sha256 TEXT,
  status TEXT NOT NULL DEFAULT 'ready',
  expires_at INTEGER,
  storage_path TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE INDEX attachments_response ON attachments(response_id, created_at);
CREATE INDEX attachments_owner ON attachments(owner_user_id, created_at);

CREATE TABLE responses (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  run_id TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
  message_id TEXT NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
  status TEXT NOT NULL,
  content TEXT NOT NULL DEFAULT '',
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  UNIQUE(message_id)
);
CREATE INDEX responses_session_updated ON responses(session_id, updated_at DESC);

CREATE TABLE response_activities (
  id TEXT PRIMARY KEY,
  response_id TEXT NOT NULL REFERENCES responses(id) ON DELETE CASCADE,
  kind TEXT NOT NULL,
  status TEXT,
  text TEXT,
  tool_name TEXT,
  attachment_id TEXT REFERENCES attachments(id) ON DELETE SET NULL,
  created_at INTEGER NOT NULL
);
CREATE INDEX response_activities_response ON response_activities(response_id, created_at);

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
  parent_message_id TEXT REFERENCES messages(id) ON DELETE SET NULL,
  attachment_ids_json TEXT NOT NULL DEFAULT '[]',
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  UNIQUE(session_id, sequence)
);
CREATE INDEX messages_session_sequence ON messages(session_id, sequence);

CREATE TABLE conversation_branches (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  head_message_id TEXT REFERENCES messages(id) ON DELETE SET NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX conversation_branches_session ON conversation_branches(session_id, updated_at DESC);

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

CREATE TABLE memory_facts (
  id TEXT PRIMARY KEY,
  owner_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  session_id TEXT REFERENCES sessions(id) ON DELETE CASCADE,
  scope TEXT NOT NULL CHECK (scope IN ('global','session')),
  key TEXT NOT NULL,
  value TEXT NOT NULL,
  category TEXT NOT NULL,
  confidence REAL NOT NULL,
  evidence TEXT,
  source_run_id TEXT REFERENCES runs(id) ON DELETE SET NULL,
  status TEXT NOT NULL CHECK (status IN ('active','candidate','superseded','rejected')),
  supersedes TEXT REFERENCES memory_facts(id) ON DELETE SET NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX memory_facts_scope_status ON memory_facts(scope,status,updated_at DESC);
CREATE VIRTUAL TABLE memory_fts USING fts5(id UNINDEXED, content, tokenize='trigram');

CREATE TABLE memory_rollups (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  kind TEXT NOT NULL CHECK (kind IN ('turn','day','session')),
  from_sequence INTEGER NOT NULL,
  to_sequence INTEGER NOT NULL,
  summary TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  UNIQUE(session_id,kind,from_sequence,to_sequence)
);
CREATE INDEX memory_rollups_session_range ON memory_rollups(session_id,to_sequence DESC);

CREATE VIRTUAL TABLE history_fts USING fts5(
  message_id UNINDEXED,
  session_id UNINDEXED,
  sequence UNINDEXED,
  content,
  tokenize='trigram'
);

CREATE TABLE agent_profiles (
  user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  content TEXT NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE quality_assessments (
  id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
  target_message_id TEXT NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
  passed INTEGER NOT NULL,
  issues_json TEXT NOT NULL,
  suggestions_json TEXT NOT NULL,
  iteration INTEGER NOT NULL CHECK(iteration BETWEEN 1 AND 3),
  created_at INTEGER NOT NULL
);
CREATE INDEX quality_assessments_run ON quality_assessments(run_id,created_at);

CREATE TABLE skill_packages (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL UNIQUE,
  version TEXT NOT NULL,
  source_type TEXT NOT NULL CHECK(source_type IN ('local','clawhub')),
  source_reference TEXT NOT NULL,
  install_path TEXT NOT NULL,
  content_hash TEXT NOT NULL,
  status TEXT NOT NULL CHECK(status IN ('staged','enabled','disabled','rejected')),
  risk TEXT NOT NULL CHECK(risk IN ('low','medium','high','extreme')),
  diagnostics_json TEXT NOT NULL,
  installed_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE optimization_proposals (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  evidence_json TEXT NOT NULL,
  risk TEXT NOT NULL CHECK(risk IN ('low','medium','high')),
  recommendation TEXT NOT NULL,
  validation_json TEXT NOT NULL,
  status TEXT NOT NULL CHECK(status IN ('pending','accepted','rejected')),
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE optimization_applications (
  id TEXT PRIMARY KEY,
  proposal_id TEXT NOT NULL REFERENCES optimization_proposals(id) ON DELETE RESTRICT,
  workspace TEXT NOT NULL,
  changes_json TEXT NOT NULL,
  backups_json TEXT NOT NULL,
  validation_command TEXT NOT NULL,
  validation_status TEXT NOT NULL CHECK(validation_status IN ('passed','failed')),
  validation_output TEXT,
  status TEXT NOT NULL CHECK(status IN ('applied','rolled_back','failed')),
  rollback_status TEXT NOT NULL CHECK(rollback_status IN ('not_requested','completed','failed')),
  error TEXT,
  created_at INTEGER NOT NULL,
  completed_at INTEGER
);
CREATE INDEX optimization_applications_proposal ON optimization_applications(proposal_id, created_at DESC);
CREATE INDEX optimization_applications_status ON optimization_applications(status, created_at DESC);

CREATE TABLE evaluation_reports (
  id TEXT PRIMARY KEY,
  mode TEXT NOT NULL CHECK (mode IN ('faux','real')),
  suite_version TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('completed','failed')),
  total INTEGER NOT NULL,
  passed INTEGER NOT NULL,
  failed INTEGER NOT NULL,
  skipped INTEGER NOT NULL,
  duration_ms INTEGER NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE INDEX evaluation_reports_created ON evaluation_reports(created_at DESC);

CREATE TABLE evaluation_cases (
  id TEXT PRIMARY KEY,
  report_id TEXT NOT NULL REFERENCES evaluation_reports(id) ON DELETE CASCADE,
  position INTEGER NOT NULL,
  name TEXT NOT NULL,
  category TEXT NOT NULL,
  passed INTEGER NOT NULL,
  duration_ms INTEGER NOT NULL,
  run_id TEXT REFERENCES runs(id) ON DELETE SET NULL,
  status TEXT,
  error TEXT,
  UNIQUE(report_id, position)
);

CREATE TABLE background_tasks (
  id TEXT PRIMARY KEY,
  parent_session_id TEXT REFERENCES sessions(id) ON DELETE SET NULL,
  session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  run_id TEXT REFERENCES runs(id) ON DELETE SET NULL,
  source_type TEXT CHECK (source_type IS NULL OR source_type='schedule'),
  source_schedule_id TEXT,
  source_schedule_run_id TEXT,
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
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
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
  branch_id TEXT REFERENCES conversation_branches(id) ON DELETE CASCADE,
  through_sequence INTEGER NOT NULL,
  content TEXT NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE knowledge_sources (
  id TEXT PRIMARY KEY,
  owner_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  path TEXT NOT NULL UNIQUE,
  document_count INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL CHECK (status IN ('queued','parsing','indexed','failed')),
  error TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE TABLE knowledge_chunks (
  id TEXT PRIMARY KEY,
  source_id TEXT NOT NULL REFERENCES knowledge_sources(id) ON DELETE CASCADE,
  file_path TEXT NOT NULL,
  position INTEGER NOT NULL,
  content TEXT NOT NULL
);
CREATE VIRTUAL TABLE knowledge_fts USING fts5(id UNINDEXED, source_id UNINDEXED, file_path UNINDEXED, content, tokenize='trigram');

CREATE TABLE knowledge_embeddings (
  chunk_id TEXT PRIMARY KEY REFERENCES knowledge_chunks(id) ON DELETE CASCADE,
  source_id TEXT NOT NULL REFERENCES knowledge_sources(id) ON DELETE CASCADE,
  model TEXT NOT NULL,
  vector_json TEXT NOT NULL,
  content_hash TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE INDEX knowledge_embeddings_source_model ON knowledge_embeddings(source_id, model);

CREATE TABLE scheduled_tasks (
  id TEXT PRIMARY KEY,
  owner_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  prompt TEXT NOT NULL,
  message_mode TEXT NOT NULL CHECK (message_mode = 'agent'),
  schedule_json TEXT NOT NULL,
  enabled INTEGER NOT NULL,
  next_run_at INTEGER,
  last_run_at INTEGER,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX scheduled_tasks_due ON scheduled_tasks(enabled,next_run_at);

CREATE TABLE scheduled_task_runs (
  id TEXT PRIMARY KEY,
  scheduled_task_id TEXT NOT NULL REFERENCES scheduled_tasks(id) ON DELETE CASCADE,
  occurrence_key TEXT NOT NULL UNIQUE,
  trigger TEXT NOT NULL CHECK (trigger IN ('scheduled','catchup','manual')),
  background_task_id TEXT REFERENCES background_tasks(id) ON DELETE SET NULL,
  run_id TEXT REFERENCES runs(id) ON DELETE SET NULL,
  status TEXT NOT NULL CHECK (status IN ('claimed','running','awaiting_resume','completed','failed','cancelled')),
  resume_json TEXT,
  scheduled_for INTEGER NOT NULL,
  started_at INTEGER,
  completed_at INTEGER,
  error TEXT
);
CREATE INDEX scheduled_task_runs_task_time ON scheduled_task_runs(scheduled_task_id,scheduled_for DESC);

CREATE TABLE web_sessions (
  id_hash TEXT PRIMARY KEY,
  user_id TEXT REFERENCES users(id) ON DELETE CASCADE,
  expires_at INTEGER NOT NULL,
  created_at INTEGER NOT NULL
);

CREATE TABLE oauth_authorization_codes (
  code TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  client_id TEXT NOT NULL,
  redirect_uri TEXT NOT NULL,
  code_challenge TEXT NOT NULL,
  expires_at INTEGER NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE INDEX oauth_codes_expiry ON oauth_authorization_codes(expires_at);

CREATE TABLE team_spaces (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  created_by TEXT NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE TABLE team_space_members (
  space_id TEXT NOT NULL REFERENCES team_spaces(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role TEXT NOT NULL CHECK(role IN ('owner','member')),
  created_at INTEGER NOT NULL,
  PRIMARY KEY(space_id,user_id)
);
CREATE TABLE external_identities (
  id TEXT PRIMARY KEY,
  provider TEXT NOT NULL,
  tenant_id TEXT NOT NULL,
  subject_id TEXT NOT NULL,
  user_id TEXT REFERENCES users(id) ON DELETE CASCADE,
  space_id TEXT REFERENCES team_spaces(id) ON DELETE CASCADE,
  created_at INTEGER NOT NULL,
  UNIQUE(provider,tenant_id,subject_id),
  CHECK((user_id IS NOT NULL) <> (space_id IS NOT NULL))
);

CREATE TABLE trace_spans (
  trace_id TEXT NOT NULL,
  span_id TEXT PRIMARY KEY,
  parent_span_id TEXT,
  run_id TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
  session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  kind TEXT NOT NULL,
  status TEXT NOT NULL CHECK(status IN ('ok','error','cancelled')),
  started_at INTEGER NOT NULL,
  duration_ms INTEGER NOT NULL,
  attributes_json TEXT NOT NULL DEFAULT '{}',
  error_type TEXT,
  error_message TEXT,
  ended_at INTEGER NOT NULL
);
CREATE INDEX trace_spans_trace_started ON trace_spans(trace_id, started_at, span_id);
CREATE INDEX trace_spans_run_started ON trace_spans(run_id, started_at, span_id);
CREATE INDEX trace_spans_session_started ON trace_spans(session_id, started_at);

CREATE TABLE resource_snapshots (
  id TEXT PRIMARY KEY,
  captured_at INTEGER NOT NULL,
  cpu_user_micros INTEGER NOT NULL,
  cpu_system_micros INTEGER NOT NULL,
  rss_bytes INTEGER NOT NULL,
  heap_used_bytes INTEGER NOT NULL,
  heap_total_bytes INTEGER NOT NULL,
  external_bytes INTEGER NOT NULL,
  array_buffers_bytes INTEGER NOT NULL,
  event_loop_delay_ms REAL NOT NULL,
  wal_bytes INTEGER NOT NULL,
  active_runs INTEGER NOT NULL,
  queued_runs INTEGER NOT NULL
);
CREATE INDEX resource_snapshots_captured ON resource_snapshots(captured_at DESC);

PRAGMA user_version = 22;
