-- 003_media_storytelling: media inventory, external links and Movie Studio projects (8 tables).

CREATE TABLE media_assets (
  id                    TEXT PRIMARY KEY,
  dataset_id            TEXT NOT NULL REFERENCES datasets (id) ON DELETE CASCADE,
  kind                  TEXT NOT NULL CHECK (kind IN
    ('image', 'video', 'audio', 'voice', 'document', 'unknown')),
  original_name         TEXT,
  mime_type             TEXT,
  byte_size             INTEGER,
  duration_ms           INTEGER,
  width                 INTEGER,
  height                INTEGER,
  content_hash          TEXT,
  storage_relative_path TEXT,
  availability          TEXT NOT NULL CHECK (availability IN
    ('available-local', 'external-link', 'missing', 'unsupported', 'not-imported')),
  imported_at           TEXT NOT NULL,
  provenance_id         TEXT NOT NULL REFERENCES provenance_records (id)
) STRICT;
CREATE INDEX idx_media_assets_dataset ON media_assets (dataset_id, kind);
CREATE INDEX idx_media_assets_hash ON media_assets (dataset_id, content_hash)
  WHERE content_hash IS NOT NULL;

CREATE TABLE media_references (
  id              TEXT PRIMARY KEY,
  dataset_id      TEXT NOT NULL REFERENCES datasets (id) ON DELETE CASCADE,
  media_asset_id  TEXT REFERENCES media_assets (id) ON DELETE SET NULL,
  message_id      TEXT REFERENCES messages (id) ON DELETE SET NULL,
  conversation_id TEXT NOT NULL REFERENCES conversations (id) ON DELETE CASCADE,
  timestamp_utc   TEXT,
  timestamp_local TEXT NOT NULL,
  caption         TEXT,
  availability    TEXT NOT NULL CHECK (availability IN
    ('available-local', 'external-link', 'missing', 'unsupported', 'not-imported'))
) STRICT;
CREATE INDEX idx_media_refs_conv_time ON media_references (dataset_id, conversation_id, timestamp_local);
CREATE INDEX idx_media_refs_asset ON media_references (media_asset_id);
CREATE INDEX idx_media_refs_message ON media_references (message_id);

CREATE TABLE external_media_links (
  id                   TEXT PRIMARY KEY,
  message_id           TEXT NOT NULL REFERENCES messages (id) ON DELETE CASCADE,
  url                  TEXT NOT NULL,
  provider             TEXT CHECK (provider IN ('spotify', 'youtube', 'apple-music', 'other')),
  title                TEXT,
  creator              TEXT,
  link_kind            TEXT NOT NULL CHECK (link_kind IN ('music', 'video', 'other')),
  resolved_metadata_at TEXT,
  UNIQUE (message_id, url)
) STRICT;

CREATE TABLE story_projects (
  id               TEXT PRIMARY KEY,
  dataset_id       TEXT NOT NULL REFERENCES datasets (id) ON DELETE CASCADE,
  title            TEXT NOT NULL CHECK (length(title) > 0),
  date_range_start TEXT,
  date_range_end   TEXT,
  status           TEXT NOT NULL CHECK (status IN ('draft', 'rendering', 'ready', 'failed')),
  aspect_ratio     TEXT NOT NULL CHECK (aspect_ratio IN ('16:9', '9:16', '1:1')),
  created_at       TEXT NOT NULL,
  updated_at       TEXT NOT NULL
) STRICT;
CREATE INDEX idx_story_projects_dataset ON story_projects (dataset_id);

CREATE TABLE story_chapters (
  id               TEXT PRIMARY KEY,
  project_id       TEXT NOT NULL REFERENCES story_projects (id) ON DELETE CASCADE,
  title            TEXT NOT NULL CHECK (length(title) > 0),
  narrative_text   TEXT,
  start_at         TEXT,
  end_at           TEXT,
  sort_order       INTEGER NOT NULL CHECK (sort_order >= 0),
  transition       TEXT NOT NULL CHECK (transition IN ('cut', 'fade', 'crossfade')),
  duration_seconds REAL NOT NULL CHECK (duration_seconds > 0)
) STRICT;
CREATE INDEX idx_story_chapters_project ON story_chapters (project_id, sort_order);

CREATE TABLE story_chapter_items (
  id              TEXT PRIMARY KEY,
  chapter_id      TEXT NOT NULL REFERENCES story_chapters (id) ON DELETE CASCADE,
  item_kind       TEXT NOT NULL CHECK (item_kind IN
    ('photo', 'video', 'audio', 'message-card', 'stat-card', 'title-card')),
  media_asset_id  TEXT REFERENCES media_assets (id) ON DELETE SET NULL,
  message_id      TEXT REFERENCES messages (id) ON DELETE SET NULL,
  sort_order      INTEGER NOT NULL CHECK (sort_order >= 0),
  start_offset_ms INTEGER,
  end_offset_ms   INTEGER
) STRICT;
CREATE INDEX idx_story_items_chapter ON story_chapter_items (chapter_id, sort_order);

CREATE TABLE soundtrack_tracks (
  id              TEXT PRIMARY KEY,
  project_id      TEXT NOT NULL REFERENCES story_projects (id) ON DELETE CASCADE,
  source_kind     TEXT NOT NULL CHECK (source_kind IN ('shared-link', 'user-file', 'licensed-library')),
  external_url    TEXT,
  local_asset_id  TEXT REFERENCES media_assets (id) ON DELETE SET NULL,
  title           TEXT,
  artist          TEXT,
  start_offset_ms INTEGER NOT NULL CHECK (start_offset_ms >= 0),
  duration_ms     INTEGER,
  rights_status   TEXT NOT NULL CHECK (rights_status IN
    ('unknown', 'user-confirmed', 'licensed', 'not-for-export'))
) STRICT;
CREATE INDEX idx_soundtrack_project ON soundtrack_tracks (project_id);

CREATE TABLE movie_exports (
  id                              TEXT PRIMARY KEY,
  project_id                      TEXT NOT NULL REFERENCES story_projects (id) ON DELETE CASCADE,
  preset                          TEXT NOT NULL CHECK (preset = '16:9'),
  status                          TEXT NOT NULL CHECK (status IN
    ('queued', 'rendering', 'completed', 'failed', 'cancelled')),
  include_message_text            INTEGER NOT NULL CHECK (include_message_text IN (0, 1)),
  include_contact_names           INTEGER NOT NULL CHECK (include_contact_names IN (0, 1)),
  included_soundtrack_track_ids_json TEXT NOT NULL DEFAULT '[]',
  link_reference_track_ids_json   TEXT NOT NULL DEFAULT '[]',
  created_at                      TEXT NOT NULL,
  completed_at                    TEXT
) STRICT;
CREATE INDEX idx_movie_exports_project ON movie_exports (project_id);
