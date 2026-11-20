-- 004_identity_ingestion: reversible contact merges, observation provenance, import checkpoints.
-- Merges never rewrite messages: `merged_into_contact_id` is resolved at read time so the
-- original sender, identifiers and provenance stay intact and unmerge is a single update.

ALTER TABLE contacts ADD COLUMN merged_into_contact_id TEXT REFERENCES contacts (id) ON DELETE SET NULL;
CREATE INDEX idx_contacts_merged_into ON contacts (merged_into_contact_id)
  WHERE merged_into_contact_id IS NOT NULL;

ALTER TABLE messages ADD COLUMN timestamp_precision TEXT
  CHECK (timestamp_precision IN ('minute', 'second'));

CREATE TABLE contact_merges (
  id                   TEXT PRIMARY KEY,
  dataset_id           TEXT NOT NULL REFERENCES datasets (id) ON DELETE CASCADE,
  primary_contact_id   TEXT NOT NULL REFERENCES contacts (id) ON DELETE CASCADE,
  secondary_contact_id TEXT NOT NULL REFERENCES contacts (id) ON DELETE CASCADE,
  merged_at            TEXT NOT NULL,
  unmerged_at          TEXT,
  reason               TEXT
) STRICT;
CREATE INDEX idx_contact_merges_dataset ON contact_merges (dataset_id, merged_at);
CREATE INDEX idx_contact_merges_secondary ON contact_merges (secondary_contact_id);

CREATE TABLE message_provenance (
  message_id    TEXT NOT NULL REFERENCES messages (id) ON DELETE CASCADE,
  provenance_id TEXT NOT NULL REFERENCES provenance_records (id) ON DELETE CASCADE,
  reason        TEXT NOT NULL CHECK (reason IN ('original', 'exact_duplicate', 'user_link')),
  PRIMARY KEY (message_id, provenance_id)
) STRICT, WITHOUT ROWID;
CREATE INDEX idx_message_provenance_prov ON message_provenance (provenance_id);

CREATE TABLE import_checkpoints (
  batch_id         TEXT PRIMARY KEY REFERENCES import_batches (id) ON DELETE CASCADE,
  plan_id          TEXT NOT NULL,
  status           TEXT NOT NULL,
  chunk_size       INTEGER NOT NULL,
  total_chunks     INTEGER NOT NULL,
  next_chunk_index INTEGER NOT NULL,
  committed_items  INTEGER NOT NULL,
  error            TEXT,
  updated_at       TEXT NOT NULL
) STRICT;

CREATE TABLE import_batch_contacts (
  batch_id   TEXT NOT NULL REFERENCES import_batches (id) ON DELETE CASCADE,
  name_key   TEXT NOT NULL,
  contact_id TEXT NOT NULL REFERENCES contacts (id) ON DELETE CASCADE,
  created    INTEGER NOT NULL CHECK (created IN (0, 1)),
  PRIMARY KEY (batch_id, name_key)
) STRICT, WITHOUT ROWID;

CREATE TABLE import_batch_conversations (
  batch_id        TEXT NOT NULL REFERENCES import_batches (id) ON DELETE CASCADE,
  conversation_id TEXT NOT NULL REFERENCES conversations (id) ON DELETE CASCADE,
  PRIMARY KEY (batch_id, conversation_id)
) STRICT, WITHOUT ROWID;

-- Rows of batches that are not yet committed stay invisible to analytics and the read models.
CREATE VIEW visible_messages AS
SELECT m.*
FROM messages m
JOIN provenance_records p ON p.id = m.provenance_id
LEFT JOIN import_batches b ON b.id = p.import_batch_id
WHERE b.id IS NULL OR b.status = 'committed';
