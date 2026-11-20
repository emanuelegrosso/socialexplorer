-- 001_core_sync: canonical archive + connector sync tables (14 tables).
-- Every dataset-scoped table cascades from datasets so dataset deletion is one statement.

CREATE TABLE datasets (
  id             TEXT PRIMARY KEY,
  name           TEXT NOT NULL CHECK (length(name) > 0),
  created_at     TEXT NOT NULL,
  timezone       TEXT NOT NULL,
  coverage_start TEXT,
  coverage_end   TEXT
) STRICT;

CREATE TABLE data_sources (
  id         TEXT PRIMARY KEY,
  dataset_id TEXT NOT NULL REFERENCES datasets (id) ON DELETE CASCADE,
  platform   TEXT NOT NULL CHECK (platform = 'whatsapp'),
  kind       TEXT NOT NULL CHECK (kind IN
    ('whatsapp-android-txt', 'whatsapp-ios-txt', 'whatsapp-zip', 'baileys-connector')),
  label      TEXT NOT NULL,
  created_at TEXT NOT NULL
) STRICT;
CREATE INDEX idx_data_sources_dataset ON data_sources (dataset_id);

CREATE TABLE import_batches (
  id                    TEXT PRIMARY KEY,
  dataset_id            TEXT NOT NULL REFERENCES datasets (id) ON DELETE CASCADE,
  source_id             TEXT NOT NULL REFERENCES data_sources (id) ON DELETE CASCADE,
  status                TEXT NOT NULL CHECK (status IN
    ('previewed', 'committing', 'committed', 'cancelled', 'failed')),
  started_at            TEXT NOT NULL,
  completed_at          TEXT,
  parsed_count          INTEGER NOT NULL DEFAULT 0,
  partial_count         INTEGER NOT NULL DEFAULT 0,
  unparsed_count        INTEGER NOT NULL DEFAULT 0,
  new_records_count     INTEGER NOT NULL DEFAULT 0,
  exact_duplicates_count INTEGER NOT NULL DEFAULT 0,
  ambiguous_count       INTEGER NOT NULL DEFAULT 0
) STRICT;
CREATE INDEX idx_import_batches_dataset ON import_batches (dataset_id, started_at);
CREATE INDEX idx_import_batches_source ON import_batches (source_id);

CREATE TABLE provenance_records (
  id                      TEXT PRIMARY KEY,
  dataset_id              TEXT NOT NULL REFERENCES datasets (id) ON DELETE CASCADE,
  source_id               TEXT NOT NULL REFERENCES data_sources (id) ON DELETE CASCADE,
  import_batch_id         TEXT REFERENCES import_batches (id) ON DELETE SET NULL,
  source_kind             TEXT NOT NULL CHECK (source_kind IN
    ('archive-import', 'baileys-history', 'baileys-live')),
  original_timestamp_text TEXT,
  source_locator          TEXT,
  parse_status            TEXT NOT NULL CHECK (parse_status IN ('complete', 'partial', 'unparsed')),
  recorded_at             TEXT NOT NULL
) STRICT;
CREATE INDEX idx_provenance_dataset ON provenance_records (dataset_id);
CREATE INDEX idx_provenance_source ON provenance_records (source_id);
CREATE INDEX idx_provenance_batch ON provenance_records (import_batch_id);

CREATE TABLE contacts (
  id           TEXT PRIMARY KEY,
  dataset_id   TEXT NOT NULL REFERENCES datasets (id) ON DELETE CASCADE,
  display_name TEXT NOT NULL,
  aliases_json TEXT NOT NULL DEFAULT '[]',
  is_self      INTEGER NOT NULL DEFAULT 0 CHECK (is_self IN (0, 1)),
  color_key    TEXT NOT NULL
) STRICT;
CREATE INDEX idx_contacts_dataset ON contacts (dataset_id);

CREATE TABLE contact_identifiers (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  dataset_id TEXT NOT NULL REFERENCES datasets (id) ON DELETE CASCADE,
  contact_id TEXT NOT NULL REFERENCES contacts (id) ON DELETE CASCADE,
  type       TEXT NOT NULL CHECK (type IN ('phone', 'jid', 'lid', 'export-name', 'other')),
  value      TEXT NOT NULL CHECK (length(value) > 0),
  source_id  TEXT REFERENCES data_sources (id) ON DELETE SET NULL,
  confidence TEXT NOT NULL CHECK (confidence IN ('confirmed', 'probable', 'unknown')),
  UNIQUE (contact_id, type, value)
) STRICT;
CREATE INDEX idx_contact_identifiers_lookup ON contact_identifiers (dataset_id, type, value);

CREATE TABLE conversations (
  id                     TEXT PRIMARY KEY,
  dataset_id             TEXT NOT NULL REFERENCES datasets (id) ON DELETE CASCADE,
  source_conversation_id TEXT,
  title                  TEXT NOT NULL,
  kind                   TEXT NOT NULL CHECK (kind IN ('private', 'group', 'other')),
  group_entity_id        TEXT REFERENCES contacts (id) ON DELETE SET NULL
) STRICT;
CREATE INDEX idx_conversations_dataset ON conversations (dataset_id);
CREATE UNIQUE INDEX idx_conversations_source
  ON conversations (dataset_id, source_conversation_id) WHERE source_conversation_id IS NOT NULL;

CREATE TABLE conversation_participants (
  conversation_id TEXT NOT NULL REFERENCES conversations (id) ON DELETE CASCADE,
  contact_id      TEXT NOT NULL REFERENCES contacts (id) ON DELETE CASCADE,
  first_seen_at   TEXT,
  last_seen_at    TEXT,
  confidence      TEXT NOT NULL CHECK (confidence IN ('confirmed', 'probable', 'unknown')),
  PRIMARY KEY (conversation_id, contact_id)
) STRICT;
CREATE INDEX idx_participants_contact ON conversation_participants (contact_id);

CREATE TABLE messages (
  id                 TEXT PRIMARY KEY,
  dataset_id         TEXT NOT NULL REFERENCES datasets (id) ON DELETE CASCADE,
  conversation_id    TEXT NOT NULL REFERENCES conversations (id) ON DELETE CASCADE,
  source_message_id  TEXT,
  sender_contact_id  TEXT REFERENCES contacts (id) ON DELETE SET NULL,
  timestamp_utc      TEXT,
  timestamp_local    TEXT NOT NULL,
  timezone           TEXT NOT NULL,
  direction          TEXT NOT NULL CHECK (direction IN ('incoming', 'outgoing', 'unknown')),
  kind               TEXT NOT NULL CHECK (kind IN
    ('text', 'image', 'video', 'audio', 'voice', 'document', 'link', 'system', 'call', 'unknown')),
  text               TEXT,
  has_attachment     INTEGER NOT NULL DEFAULT 0 CHECK (has_attachment IN (0, 1)),
  is_edited          INTEGER CHECK (is_edited IN (0, 1)),
  is_deleted         INTEGER CHECK (is_deleted IN (0, 1)),
  source_kind        TEXT NOT NULL CHECK (source_kind IN
    ('archive-import', 'baileys-history', 'baileys-live')),
  parse_status       TEXT NOT NULL CHECK (parse_status IN ('complete', 'partial', 'unparsed')),
  provenance_id      TEXT NOT NULL REFERENCES provenance_records (id),
  fingerprint        TEXT
) STRICT;
CREATE INDEX idx_messages_conv_time ON messages (dataset_id, conversation_id, timestamp_utc);
CREATE INDEX idx_messages_conv_local ON messages (dataset_id, conversation_id, timestamp_local);
CREATE INDEX idx_messages_dataset_time ON messages (dataset_id, timestamp_utc);
CREATE INDEX idx_messages_sender_time ON messages (sender_contact_id, timestamp_utc);
CREATE INDEX idx_messages_provenance ON messages (provenance_id);
CREATE INDEX idx_messages_fingerprint ON messages (dataset_id, conversation_id, fingerprint)
  WHERE fingerprint IS NOT NULL;
CREATE UNIQUE INDEX idx_messages_source_id
  ON messages (dataset_id, conversation_id, source_message_id) WHERE source_message_id IS NOT NULL;

CREATE TABLE message_reactions (
  id                 TEXT PRIMARY KEY,
  message_id         TEXT NOT NULL REFERENCES messages (id) ON DELETE CASCADE,
  reactor_contact_id TEXT REFERENCES contacts (id) ON DELETE SET NULL,
  emoji              TEXT NOT NULL CHECK (length(emoji) > 0),
  reacted_at_utc     TEXT,
  provenance_id      TEXT NOT NULL REFERENCES provenance_records (id)
) STRICT;
CREATE INDEX idx_reactions_message ON message_reactions (message_id);

CREATE TABLE sync_state (
  source_id        TEXT PRIMARY KEY REFERENCES data_sources (id) ON DELETE CASCADE,
  dataset_id       TEXT NOT NULL REFERENCES datasets (id) ON DELETE CASCADE,
  status           TEXT NOT NULL CHECK (status IN
    ('idle', 'syncing', 'partial', 'complete', 'error', 'logged-out')),
  last_sync_at     TEXT,
  last_error_code  TEXT,
  coverage_start   TEXT,
  coverage_end     TEXT,
  partial_warning  TEXT,
  updated_at       TEXT NOT NULL
) STRICT;
CREATE INDEX idx_sync_state_dataset ON sync_state (dataset_id);

CREATE TABLE sync_checkpoints (
  source_id   TEXT NOT NULL REFERENCES data_sources (id) ON DELETE CASCADE,
  kind        TEXT NOT NULL,
  cursor_json TEXT NOT NULL,
  updated_at  TEXT NOT NULL,
  PRIMARY KEY (source_id, kind)
) STRICT;

CREATE TABLE app_settings (
  key        TEXT PRIMARY KEY,
  value_json TEXT NOT NULL,
  updated_at TEXT NOT NULL
) STRICT;

CREATE TABLE annotations (
  id         TEXT PRIMARY KEY,
  dataset_id TEXT NOT NULL REFERENCES datasets (id) ON DELETE CASCADE,
  target_kind TEXT NOT NULL CHECK (target_kind IN
    ('message', 'media', 'conversation', 'contact', 'time-interval')),
  target_id  TEXT NOT NULL,
  note       TEXT,
  bookmarked INTEGER NOT NULL DEFAULT 0 CHECK (bookmarked IN (0, 1)),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
) STRICT;
CREATE INDEX idx_annotations_target ON annotations (dataset_id, target_kind, target_id);
