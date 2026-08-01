-- Aggregate-scoped operations and their upload queue.
--
-- Kept separate from the protocol-v1 `batches`/`outbox` tables: these carry
-- v2 envelopes addressed by (kind, aggregate), which v1 has no column for.
CREATE TABLE aggregate_batches (
    aggregate_kind TEXT NOT NULL,
    aggregate_id TEXT NOT NULL,
    device_id TEXT NOT NULL,
    sequence TEXT NOT NULL CHECK (length(sequence) = 20),
    path TEXT NOT NULL UNIQUE,
    payload_sha256 TEXT NOT NULL CHECK (length(payload_sha256) = 64),
    envelope_json TEXT NOT NULL,
    origin TEXT NOT NULL CHECK (origin IN ('local', 'remote')),
    applied_at TEXT NOT NULL,
    PRIMARY KEY (aggregate_kind, aggregate_id, device_id, sequence)
);

CREATE TABLE aggregate_outbox (
    aggregate_kind TEXT NOT NULL,
    aggregate_id TEXT NOT NULL,
    device_id TEXT NOT NULL,
    sequence TEXT NOT NULL,
    enqueued_at TEXT NOT NULL,
    attempts INTEGER NOT NULL DEFAULT 0 CHECK (attempts >= 0),
    last_error TEXT,
    PRIMARY KEY (aggregate_kind, aggregate_id, device_id, sequence),
    FOREIGN KEY (aggregate_kind, aggregate_id, device_id, sequence)
        REFERENCES aggregate_batches(aggregate_kind, aggregate_id, device_id, sequence)
        ON DELETE CASCADE
);

-- List projection for the zen workspace.
--
-- Deliberately excludes the body: opening the workspace must stay proportional
-- to the number of documents, never their size. Bodies live in
-- `aggregate_state` and are read only when a document is opened.
CREATE TABLE zen_documents (
    document_id TEXT PRIMARY KEY,
    title TEXT,
    byte_length INTEGER NOT NULL CHECK (byte_length >= 0),
    todo_total INTEGER NOT NULL CHECK (todo_total >= 0),
    todo_done INTEGER NOT NULL CHECK (todo_done >= 0),
    created_at INTEGER NOT NULL,
    edited_at TEXT NOT NULL,
    lifecycle_state TEXT NOT NULL CHECK (lifecycle_state IN ('active', 'deleted'))
);

CREATE INDEX zen_documents_edited_at ON zen_documents(edited_at DESC, document_id ASC);

CREATE TABLE zen_document_tags (
    document_id TEXT NOT NULL REFERENCES zen_documents(document_id) ON DELETE CASCADE,
    tag TEXT NOT NULL,
    PRIMARY KEY (document_id, tag)
);

CREATE INDEX zen_document_tags_tag ON zen_document_tags(tag, document_id);
