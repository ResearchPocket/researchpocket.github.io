-- Firecrawl normally writes its full-page Markdown as a captured document.
-- Preserve the owner's explicit `--replace-excerpt` intent across leases and
-- retries so that one deliberate run may also replace the authored excerpt.
ALTER TABLE item_enrichment_jobs
    ADD COLUMN replace_excerpt INTEGER NOT NULL DEFAULT 0
        CHECK (replace_excerpt IN (0, 1));
