-- PromptDashboard schema. Applied idempotently by db/migrate.ts.

CREATE TABLE IF NOT EXISTS sources (
  id             SERIAL PRIMARY KEY,
  name           TEXT NOT NULL UNIQUE,          -- folder name under /sources
  label          TEXT NOT NULL,                 -- display name
  enabled        BOOLEAN NOT NULL DEFAULT TRUE,
  retention_days INT,                           -- NULL = use global setting
  last_cursor_ts TIMESTAMPTZ,
  last_sync_at   TIMESTAMPTZ,
  last_error     TEXT,
  gap_detected   BOOLEAN NOT NULL DEFAULT FALSE,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Other machines running only 9router + the read-only agent; their 9routers become sources named "<server>/<name>".
CREATE TABLE IF NOT EXISTS servers (
  id          SERIAL PRIMARY KEY,
  name        TEXT NOT NULL UNIQUE CHECK (name ~ '^[A-Za-z0-9._-]{1,40}$'),
  label       TEXT NOT NULL,
  url         TEXT NOT NULL,
  token       TEXT NOT NULL,
  enabled     BOOLEAN NOT NULL DEFAULT TRUE,
  last_seen_at TIMESTAMPTZ,
  last_error  TEXT,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
-- a paired Windows agent (agent-windows/): SHA-256 of its certificate; token is then its HMAC key (hex)
ALTER TABLE servers ADD COLUMN IF NOT EXISTS cert_sha256 TEXT;
-- what the agent last said about itself and its sources (a Windows PC: computer name, accounts, Cursor emails)
ALTER TABLE servers ADD COLUMN IF NOT EXISTS info JSONB;
-- self-update of a Windows agent: when the dashboard last pushed a new exe, and the last push error if any
ALTER TABLE servers ADD COLUMN IF NOT EXISTS agent_update_at TIMESTAMPTZ;
ALTER TABLE servers ADD COLUMN IF NOT EXISTS agent_update_error TEXT;
-- install links: one PowerShell line that installs the Windows agent and pairs the PC (api/install.ts).
-- Only the SHA-256 of the token is kept; the token itself is shown once.
CREATE TABLE IF NOT EXISTS install_links (
  id           SERIAL PRIMARY KEY,
  token_hash   TEXT NOT NULL UNIQUE,
  base_url     TEXT NOT NULL,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at   TIMESTAMPTZ NOT NULL,
  revoked_at   TIMESTAMPTZ,
  uses         INT NOT NULL DEFAULT 0,
  last_used_at TIMESTAMPTZ
);
ALTER TABLE sources ADD COLUMN IF NOT EXISTS server_id INT REFERENCES servers(id) ON DELETE CASCADE;
ALTER TABLE sources ADD COLUMN IF NOT EXISTS remote_name TEXT;
-- folder of data.sqlite relative to SOURCES_DIR (NULL = the name); set when the folder disappears
ALTER TABLE sources ADD COLUMN IF NOT EXISTS path TEXT;
ALTER TABLE sources ADD COLUMN IF NOT EXISTS missing_since TIMESTAMPTZ;

CREATE TABLE IF NOT EXISTS users (
  id           SERIAL PRIMARY KEY,
  source_id    INT NOT NULL REFERENCES sources(id) ON DELETE CASCADE,
  fingerprint  TEXT NOT NULL,
  hint         TEXT NOT NULL DEFAULT '',
  display_name TEXT,
  merged_into  INT REFERENCES users(id) ON DELETE SET NULL,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (source_id, fingerprint)
);

CREATE TABLE IF NOT EXISTS sessions (
  id                  SERIAL PRIMARY KEY,
  source_id           INT NOT NULL REFERENCES sources(id) ON DELETE CASCADE,
  user_id             INT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  thread_key          TEXT NOT NULL,
  external_session_id TEXT,
  title               TEXT NOT NULL DEFAULT '',
  first_at            TIMESTAMPTZ NOT NULL,
  last_at             TIMESTAMPTZ NOT NULL,
  UNIQUE (source_id, thread_key)
);
CREATE INDEX IF NOT EXISTS sessions_user_idx ON sessions(user_id, last_at DESC);
CREATE INDEX IF NOT EXISTS sessions_last_idx ON sessions(last_at);

CREATE TABLE IF NOT EXISTS messages (
  id            BIGSERIAL PRIMARY KEY,
  session_id    INT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  seq           INT NOT NULL,
  role          TEXT NOT NULL,
  kind          TEXT NOT NULL,
  content_hash  TEXT NOT NULL,                  -- the text itself is in texts (one copy per distinct content)
  meta          JSONB,
  search        TEXT NOT NULL DEFAULT '',        -- folded text for search
  created_at    TIMESTAMPTZ NOT NULL,
  UNIQUE (session_id, seq)
);

-- Message text, stored once per distinct content (texts.hash = messages.content_hash): reminders, CLAUDE.md, skill
-- lists and tool output that every thread and subagent repeats take the room of one copy. Nothing is cut: a text
-- of any size is kept whole. toast_tuple_target lets Postgres compress (lz4) every text above ~128 bytes, not only
-- those over 2 KB.
CREATE TABLE IF NOT EXISTS texts (
  hash TEXT PRIMARY KEY,
  len  INT NOT NULL,                             -- characters: listing a thread does not decompress every text
  body TEXT NOT NULL
);
ALTER TABLE texts SET (toast_tuple_target = 128);
-- databases from before texts: move the text out of messages (the space is given back by compactStorage)
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = current_schema() AND table_name = 'messages' AND column_name = 'text') THEN
    INSERT INTO texts(hash, len, body)
      SELECT DISTINCT ON (content_hash) content_hash, length(text), text FROM messages ORDER BY content_hash, id
      ON CONFLICT (hash) DO NOTHING;
    ALTER TABLE messages DROP COLUMN text;
  END IF;
END $$;
-- finds texts no message uses any more (pruneTexts)
CREATE INDEX IF NOT EXISTS messages_hash_idx ON messages(content_hash);
-- search is a LIKE on the small folded column; these were never used
DROP INDEX IF EXISTS messages_search_idx;
DROP INDEX IF EXISTS messages_created_idx;

CREATE TABLE IF NOT EXISTS requests (
  id            TEXT PRIMARY KEY,                -- 9router requestDetails.id
  source_id     INT NOT NULL REFERENCES sources(id) ON DELETE CASCADE,
  session_id    INT REFERENCES sessions(id) ON DELETE SET NULL,
  user_id       INT REFERENCES users(id) ON DELETE SET NULL,
  ts            TIMESTAMPTZ NOT NULL,
  model         TEXT NOT NULL,
  provider      TEXT NOT NULL DEFAULT '',
  status        TEXT NOT NULL DEFAULT '',
  kind          TEXT NOT NULL DEFAULT 'main',
  input_tokens  BIGINT NOT NULL DEFAULT 0,
  output_tokens BIGINT NOT NULL DEFAULT 0,
  cache_read    BIGINT NOT NULL DEFAULT 0,
  cache_write   BIGINT NOT NULL DEFAULT 0,
  latency_ms    INT,
  ttft_ms       INT,
  truncated     BOOLEAN NOT NULL DEFAULT FALSE,
  original_size BIGINT,
  preview       TEXT,
  msg_from_seq  INT,                             -- new history messages this request introduced: (from, to]
  msg_to_seq    INT,
  history_len   INT NOT NULL DEFAULT 0,
  response      JSONB,                           -- normalised response blocks
  human_count   INT NOT NULL DEFAULT 0           -- new human-typed messages introduced by this request
);
CREATE INDEX IF NOT EXISTS requests_ts_idx ON requests(ts);
CREATE INDEX IF NOT EXISTS requests_session_idx ON requests(session_id, ts);
CREATE INDEX IF NOT EXISTS requests_user_idx ON requests(user_id, ts);
CREATE INDEX IF NOT EXISTS requests_source_idx ON requests(source_id, ts);

-- One conversation = one Claude Code / chat session as the person sees it. A conversation holds one or more
-- threads (rows of `sessions`): the main thread, its continuations after compaction, rewinds/edits (branches)
-- and the subagents it started. Returning to an old chat appends to the same conversation.
CREATE TABLE IF NOT EXISTS conversations (
  id                  SERIAL PRIMARY KEY,
  source_id           INT NOT NULL REFERENCES sources(id) ON DELETE CASCADE,
  user_id             INT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  external_session_id TEXT,
  title               TEXT NOT NULL DEFAULT '',
  machine_user        TEXT NOT NULL DEFAULT '',          -- OS account seen in the prompts (C:\Users\<x>)
  first_at            TIMESTAMPTZ NOT NULL,
  last_at             TIMESTAMPTZ NOT NULL
);
CREATE INDEX IF NOT EXISTS conversations_user_idx ON conversations(user_id, last_at DESC);
CREATE INDEX IF NOT EXISTS conversations_last_idx ON conversations(last_at);
CREATE INDEX IF NOT EXISTS conversations_ext_idx ON conversations(source_id, external_session_id);

ALTER TABLE sessions ADD COLUMN IF NOT EXISTS conversation_id INT REFERENCES conversations(id) ON DELETE CASCADE;
ALTER TABLE sessions ADD COLUMN IF NOT EXISTS thread_kind TEXT NOT NULL DEFAULT 'main';   -- main | continuation | branch | subagent
ALTER TABLE sessions ADD COLUMN IF NOT EXISTS skip_seq INT NOT NULL DEFAULT 0;            -- branch: messages <= skip_seq repeat the parent
ALTER TABLE sessions ADD COLUMN IF NOT EXISTS root_hash TEXT;                             -- first user turn + first answer, finds resumed chats
CREATE INDEX IF NOT EXISTS sessions_conv_idx ON sessions(conversation_id);
CREATE INDEX IF NOT EXISTS sessions_ext_idx ON sessions(source_id, external_session_id);
CREATE INDEX IF NOT EXISTS sessions_root_idx ON sessions(source_id, root_hash);

ALTER TABLE requests ADD COLUMN IF NOT EXISTS conversation_id INT REFERENCES conversations(id) ON DELETE SET NULL;
ALTER TABLE requests ADD COLUMN IF NOT EXISTS api_key TEXT;                                -- 9router api key id (never the secret)
CREATE INDEX IF NOT EXISTS requests_conv_idx ON requests(conversation_id, ts);
-- the person behind the key: OS account seen in the prompts (C:\Users\<x>); a key may be used by several
ALTER TABLE requests ADD COLUMN IF NOT EXISTS client TEXT NOT NULL DEFAULT '';
CREATE INDEX IF NOT EXISTS requests_client_idx ON requests(source_id, client, ts);

CREATE TABLE IF NOT EXISTS schedules (
  id          SERIAL PRIMARY KEY,
  name        TEXT NOT NULL,
  source_ids  INT[] NOT NULL DEFAULT '{}',        -- empty = all enabled sources
  mode        TEXT NOT NULL CHECK (mode IN ('interval','cron')),
  every_min   INT,
  cron        TEXT,
  days        INT[],                              -- 0=Sunday..6=Saturday (Tehran), NULL = all days
  from_hour   INT,                                -- Tehran hour window, NULL = all day
  to_hour     INT,
  enabled     BOOLEAN NOT NULL DEFAULT TRUE,
  last_run_at TIMESTAMPTZ,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS sync_runs (
  id          BIGSERIAL PRIMARY KEY,
  source_id   INT NOT NULL REFERENCES sources(id) ON DELETE CASCADE,
  schedule_id INT REFERENCES schedules(id) ON DELETE SET NULL,
  trigger     TEXT NOT NULL DEFAULT 'schedule',   -- schedule | manual
  started_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  finished_at TIMESTAMPTZ,
  rows_read   INT NOT NULL DEFAULT 0,
  rows_new    INT NOT NULL DEFAULT 0,
  gap         BOOLEAN NOT NULL DEFAULT FALSE,
  error       TEXT
);
CREATE INDEX IF NOT EXISTS sync_runs_started_idx ON sync_runs(started_at DESC);

CREATE TABLE IF NOT EXISTS settings (
  key   TEXT PRIMARY KEY,
  value JSONB NOT NULL
);

-- One card per 9router (detected from its docker-compose.yml) or added by hand: addresses, domains, login password.
CREATE TABLE IF NOT EXISTS panels (
  id            SERIAL PRIMARY KEY,
  source_id     INT UNIQUE REFERENCES sources(id) ON DELETE CASCADE,  -- set for detected 9routers
  name          TEXT NOT NULL,
  org           TEXT NOT NULL DEFAULT '',
  container     TEXT,                       -- reachable on 9router-net as http://<container>:20128 (health check)
  panel_port    INT,                        -- host ports from the compose file
  quota_port    INT,
  panel_domain  TEXT,                       -- the only addresses shown: 9routers are reached through their domains
  quota_domain  TEXT,
  password_enc  TEXT,                       -- AES-256-GCM, key derived from the session secret
  password_from TEXT,                       -- where the password came from, e.g. ".env (INITIAL_PASSWORD)"
  password_at   TIMESTAMPTZ,
  notes         TEXT NOT NULL DEFAULT '',
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);
ALTER TABLE panels DROP COLUMN IF EXISTS role;
ALTER TABLE panels DROP COLUMN IF EXISTS panel_url;
ALTER TABLE panels DROP COLUMN IF EXISTS quota_url;
-- deleted cards wait PANEL_KEEP_DAYS (restorable), then are purged: hand-made rows go away, a detected 9router's row
-- stays as an empty tombstone (purged_at) so the next scan does not bring the card back
ALTER TABLE panels ADD COLUMN IF NOT EXISTS deleted_at TIMESTAMPTZ;
ALTER TABLE panels ADD COLUMN IF NOT EXISTS purged_at TIMESTAMPTZ;
