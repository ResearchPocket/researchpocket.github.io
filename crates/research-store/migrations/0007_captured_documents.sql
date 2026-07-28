ALTER TABLE items ADD COLUMN captured_document_json TEXT;

CREATE TABLE captured_documents (
    sha256 TEXT PRIMARY KEY CHECK (length(sha256) = 64),
    path TEXT NOT NULL UNIQUE,
    markdown TEXT NOT NULL,
    byte_length INTEGER NOT NULL CHECK (byte_length > 0 AND byte_length <= 4194304),
    media_type TEXT NOT NULL,
    provider TEXT NOT NULL,
    source_url TEXT NOT NULL,
    captured_at TEXT NOT NULL,
    created_at TEXT NOT NULL,
    remote_blob_sha TEXT
);
