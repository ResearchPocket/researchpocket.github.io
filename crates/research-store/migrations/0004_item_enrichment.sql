CREATE TABLE item_enrichment_jobs (
    item_id TEXT PRIMARY KEY REFERENCES items(item_id) ON DELETE CASCADE,
    provider TEXT NOT NULL CHECK (provider IN ('direct', 'firecrawl')),
    status TEXT NOT NULL CHECK (
        status IN ('pending', 'retry', 'in_progress', 'succeeded', 'failed', 'skipped')
    ),
    attempts INTEGER NOT NULL DEFAULT 0 CHECK (attempts >= 0),
    target_title INTEGER NOT NULL CHECK (target_title IN (0, 1)),
    target_excerpt INTEGER NOT NULL CHECK (target_excerpt IN (0, 1)),
    target_language INTEGER NOT NULL CHECK (target_language IN (0, 1)),
    expected_title_revision TEXT,
    expected_excerpt_revision TEXT,
    expected_language_revision TEXT,
    queued_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    next_attempt_at TEXT,
    last_attempt_at TEXT,
    completed_at TEXT,
    lease_token TEXT,
    lease_expires_at TEXT,
    last_error_kind TEXT CHECK (
        last_error_kind IS NULL OR (
            length(last_error_kind) BETWEEN 1 AND 64
            AND last_error_kind NOT GLOB '*[^a-z0-9_]*'
        )
    ),
    CHECK ((target_title = 1) = (expected_title_revision IS NOT NULL)),
    CHECK ((target_excerpt = 1) = (expected_excerpt_revision IS NOT NULL)),
    CHECK ((target_language = 1) = (expected_language_revision IS NOT NULL)),
    CHECK (
        (status = 'in_progress' AND lease_token IS NOT NULL AND lease_expires_at IS NOT NULL)
        OR
        (status != 'in_progress' AND lease_token IS NULL AND lease_expires_at IS NULL)
    )
);

CREATE INDEX item_enrichment_jobs_due
    ON item_enrichment_jobs(status, next_attempt_at, lease_expires_at, queued_at, item_id);
