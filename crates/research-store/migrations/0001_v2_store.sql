CREATE TABLE store_meta (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
);

CREATE TABLE canonical_state (
    singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
    snapshot BLOB NOT NULL,
    snapshot_sha256 TEXT NOT NULL CHECK (length(snapshot_sha256) = 64),
    updated_at TEXT NOT NULL
);

CREATE TABLE devices (
    device_id TEXT PRIMARY KEY,
    next_sequence TEXT NOT NULL CHECK (length(next_sequence) = 20)
);

CREATE TABLE items (
    item_id TEXT PRIMARY KEY,
    url TEXT NOT NULL,
    title TEXT,
    excerpt TEXT,
    favorite INTEGER NOT NULL CHECK (favorite IN (0, 1)),
    language TEXT,
    saved_at INTEGER NOT NULL,
    note TEXT NOT NULL,
    lifecycle_state TEXT NOT NULL CHECK (lifecycle_state IN ('active', 'deleted')),
    lifecycle_generation INTEGER NOT NULL CHECK (lifecycle_generation >= 0)
);

CREATE INDEX items_saved_at ON items(saved_at DESC, item_id ASC);

CREATE TABLE item_tags (
    item_id TEXT NOT NULL REFERENCES items(item_id) ON DELETE CASCADE,
    tag TEXT NOT NULL,
    PRIMARY KEY (item_id, tag)
);

CREATE INDEX item_tags_tag ON item_tags(tag, item_id);

CREATE TABLE batches (
    device_id TEXT NOT NULL,
    sequence TEXT NOT NULL CHECK (length(sequence) = 20),
    payload_sha256 TEXT NOT NULL CHECK (length(payload_sha256) = 64),
    protocol_version INTEGER NOT NULL,
    library_id TEXT NOT NULL,
    path TEXT NOT NULL UNIQUE,
    envelope_json TEXT NOT NULL,
    origin TEXT NOT NULL CHECK (origin IN ('local', 'remote')),
    applied_at TEXT NOT NULL,
    PRIMARY KEY (device_id, sequence)
);

CREATE INDEX batches_payload_sha256 ON batches(payload_sha256);

CREATE TABLE outbox (
    device_id TEXT NOT NULL,
    sequence TEXT NOT NULL,
    enqueued_at TEXT NOT NULL,
    attempts INTEGER NOT NULL DEFAULT 0 CHECK (attempts >= 0),
    last_error TEXT,
    PRIMARY KEY (device_id, sequence),
    FOREIGN KEY (device_id, sequence) REFERENCES batches(device_id, sequence) ON DELETE CASCADE
);

CREATE TABLE import_sources (
    source_id INTEGER PRIMARY KEY AUTOINCREMENT,
    source_kind TEXT NOT NULL,
    source_digest TEXT NOT NULL UNIQUE CHECK (length(source_digest) = 64),
    bundle_receipt_json TEXT NOT NULL,
    first_seen_at TEXT NOT NULL,
    last_seen_at TEXT NOT NULL
);

CREATE TABLE import_rows (
    row_identity TEXT PRIMARY KEY CHECK (length(row_identity) = 64),
    content_sha256 TEXT NOT NULL CHECK (length(content_sha256) = 64),
    item_id TEXT NOT NULL UNIQUE REFERENCES items(item_id),
    provider TEXT NOT NULL,
    legacy_id INTEGER NOT NULL,
    first_source_id INTEGER NOT NULL REFERENCES import_sources(source_id),
    imported_at TEXT NOT NULL
);

CREATE TABLE import_source_rows (
    source_id INTEGER NOT NULL REFERENCES import_sources(source_id) ON DELETE CASCADE,
    row_identity TEXT NOT NULL,
    item_id TEXT NOT NULL REFERENCES items(item_id),
    disposition TEXT NOT NULL CHECK (disposition IN ('imported', 'already_imported')),
    PRIMARY KEY (source_id, row_identity)
);

CREATE TABLE import_rejections (
    source_id INTEGER NOT NULL REFERENCES import_sources(source_id) ON DELETE CASCADE,
    legacy_id INTEGER,
    field TEXT NOT NULL,
    code TEXT NOT NULL,
    reason TEXT NOT NULL,
    PRIMARY KEY (source_id, legacy_id, field, code)
);
