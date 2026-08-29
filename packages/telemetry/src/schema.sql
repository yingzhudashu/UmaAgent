PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS spans (
  span_id TEXT PRIMARY KEY,
  trace_id TEXT NOT NULL,
  parent_span_id TEXT,
  service TEXT NOT NULL,
  run_id TEXT,
  session_id TEXT,
  name TEXT NOT NULL,
  kind TEXT NOT NULL,
  status TEXT NOT NULL CHECK(status IN ('active','ok','error','cancelled')),
  started_at INTEGER NOT NULL,
  ended_at INTEGER,
  duration_ms INTEGER,
  attributes_json TEXT NOT NULL DEFAULT '{}',
  error_type TEXT,
  error_message TEXT
);
CREATE INDEX IF NOT EXISTS spans_trace_started ON spans(trace_id, started_at, span_id);
CREATE INDEX IF NOT EXISTS spans_run_started ON spans(run_id, started_at, span_id);
CREATE INDEX IF NOT EXISTS spans_started ON spans(started_at);
CREATE INDEX IF NOT EXISTS spans_status_started ON spans(status, started_at, span_id);
CREATE INDEX IF NOT EXISTS spans_service_started ON spans(service, started_at, span_id);

CREATE TABLE IF NOT EXISTS span_events (
  span_id TEXT NOT NULL REFERENCES spans(span_id) ON DELETE CASCADE,
  event_no INTEGER NOT NULL,
  name TEXT NOT NULL,
  occurred_at INTEGER NOT NULL,
  attributes_json TEXT NOT NULL DEFAULT '{}',
  PRIMARY KEY(span_id, event_no)
);

CREATE TABLE IF NOT EXISTS resource_samples (
  id TEXT PRIMARY KEY,
  service TEXT NOT NULL,
  captured_at INTEGER NOT NULL,
  cpu_user_micros INTEGER NOT NULL,
  cpu_system_micros INTEGER NOT NULL,
  rss_bytes INTEGER NOT NULL,
  heap_used_bytes INTEGER NOT NULL,
  heap_total_bytes INTEGER NOT NULL,
  external_bytes INTEGER NOT NULL,
  array_buffers_bytes INTEGER NOT NULL,
  event_loop_delay_ms REAL NOT NULL,
  active_runs INTEGER NOT NULL,
  queued_runs INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS resource_samples_captured ON resource_samples(captured_at DESC);

CREATE TABLE IF NOT EXISTS run_trace_links (
  run_id TEXT NOT NULL,
  trace_id TEXT NOT NULL,
  linked_at INTEGER NOT NULL,
  PRIMARY KEY(run_id, trace_id)
);
CREATE INDEX IF NOT EXISTS run_trace_links_trace ON run_trace_links(trace_id);

CREATE TABLE IF NOT EXISTS span_aggregates (
  bucket_start INTEGER NOT NULL,
  bucket_ms INTEGER NOT NULL,
  service TEXT NOT NULL,
  name TEXT NOT NULL,
  status TEXT NOT NULL,
  count INTEGER NOT NULL,
  total_duration_ms INTEGER NOT NULL,
  min_duration_ms INTEGER NOT NULL,
  max_duration_ms INTEGER NOT NULL,
  PRIMARY KEY(bucket_start, bucket_ms, service, name, status)
);
CREATE INDEX IF NOT EXISTS span_aggregates_bucket ON span_aggregates(bucket_start DESC);
