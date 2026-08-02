-- Let a device record a v2 generation it adopted rather than performed.
--
-- Only the device that migrates writes the v1 barrier operation. Every other
-- device receives that barrier through ordinary v1 synchronization and then
-- adopts the published genesis, so its migration record has no barrier of its
-- own to point at. The original table required one, which made adoption
-- impossible to express.
--
-- SQLite cannot drop a foreign key in place, so the table is rebuilt. Nothing
-- else about the record changes: the exact protocol bytes remain the only
-- stored truth, and every identity is still derived by validating them.
CREATE TABLE aggregate_migration_rebuilt (
    singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
    library_id TEXT NOT NULL,
    catalogue_json TEXT NOT NULL,
    genesis_json TEXT NOT NULL,
    barrier_device_id TEXT,
    barrier_sequence TEXT CHECK (
        barrier_sequence IS NULL OR length(barrier_sequence) = 20
    ),
    migrated_at TEXT NOT NULL,
    -- A barrier is either fully identified or absent; never half of one.
    CHECK ((barrier_device_id IS NULL) = (barrier_sequence IS NULL))
);

INSERT INTO aggregate_migration_rebuilt
SELECT singleton, library_id, catalogue_json, genesis_json, barrier_device_id,
       barrier_sequence, migrated_at
FROM aggregate_migration;

DROP TABLE aggregate_migration;

ALTER TABLE aggregate_migration_rebuilt RENAME TO aggregate_migration;
