-- Excerpt became merged text in domain schema 3, so it no longer has a
-- revision ID to compare against. Enrichment now guards on the excerpt text it
-- observed when the job was queued, and remembers what it last wrote so a
-- re-queue can still tell an enrichment-authored excerpt from a human one.
ALTER TABLE item_enrichment_jobs
    RENAME COLUMN expected_excerpt_revision TO expected_excerpt_text;

ALTER TABLE item_enrichment_jobs
    ADD COLUMN applied_excerpt_text TEXT;
