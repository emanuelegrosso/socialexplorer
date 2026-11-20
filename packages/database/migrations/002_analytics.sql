-- 002_analytics: derived, fully rebuildable aggregates (2 tables).
-- sender_key is the sender contact id, or '' for messages without a known sender.

CREATE TABLE analytics_daily (
  dataset_id       TEXT NOT NULL REFERENCES datasets (id) ON DELETE CASCADE,
  conversation_id  TEXT NOT NULL REFERENCES conversations (id) ON DELETE CASCADE,
  sender_key       TEXT NOT NULL,
  date_local       TEXT NOT NULL,
  message_count    INTEGER NOT NULL,
  attachment_count INTEGER NOT NULL,
  character_count  INTEGER NOT NULL,
  computed_at      TEXT NOT NULL,
  PRIMARY KEY (dataset_id, conversation_id, sender_key, date_local)
) STRICT, WITHOUT ROWID;
CREATE INDEX idx_analytics_daily_date ON analytics_daily (dataset_id, date_local);

CREATE TABLE analytics_hourly (
  dataset_id       TEXT NOT NULL REFERENCES datasets (id) ON DELETE CASCADE,
  conversation_id  TEXT NOT NULL REFERENCES conversations (id) ON DELETE CASCADE,
  sender_key       TEXT NOT NULL,
  date_local       TEXT NOT NULL,
  hour_local       INTEGER NOT NULL CHECK (hour_local BETWEEN 0 AND 23),
  message_count    INTEGER NOT NULL,
  computed_at      TEXT NOT NULL,
  PRIMARY KEY (dataset_id, conversation_id, sender_key, date_local, hour_local)
) STRICT, WITHOUT ROWID;
CREATE INDEX idx_analytics_hourly_date ON analytics_hourly (dataset_id, date_local);
