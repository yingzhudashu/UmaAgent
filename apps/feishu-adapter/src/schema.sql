PRAGMA journal_mode = WAL;
CREATE TABLE conversation_maps (
  id TEXT PRIMARY KEY,
  tenant_key TEXT NOT NULL,
  chat_type TEXT NOT NULL,
  chat_id TEXT NOT NULL,
  thread_root_id TEXT NOT NULL DEFAULT '',
  uma_session_id TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  UNIQUE(tenant_key, chat_type, chat_id, thread_root_id)
);
CREATE TABLE inbound_messages (
  external_message_id TEXT PRIMARY KEY,
  conversation_map_id TEXT NOT NULL REFERENCES conversation_maps(id) ON DELETE CASCADE,
  sender_id TEXT,
  raw_type TEXT NOT NULL,
  uma_message_id TEXT NOT NULL UNIQUE,
  status TEXT NOT NULL,
  received_at INTEGER NOT NULL,
  processed_at INTEGER,
  error TEXT
);
CREATE TABLE outbound_cards (
  id TEXT PRIMARY KEY,
  conversation_map_id TEXT NOT NULL REFERENCES conversation_maps(id) ON DELETE CASCADE,
  run_id TEXT NOT NULL,
  feishu_message_id TEXT,
  last_rendered_sequence INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL,
  error TEXT,
  updated_at INTEGER NOT NULL
);
CREATE TABLE approval_callbacks (
  id TEXT PRIMARY KEY,
  approval_id TEXT NOT NULL,
  feishu_message_id TEXT NOT NULL,
  callback_token_hash TEXT NOT NULL,
  expires_at INTEGER NOT NULL,
  status TEXT NOT NULL
);
