-- Local state for the item-aggregates-v2 generation.
--
-- Protocol-v1 tables are left untouched: migration never rewrites or prunes v1
-- history, and the v1 canonical snapshot remains the projection source until a
-- later change moves mutations onto aggregates.

-- One CRDT replica per aggregate, replacing the single-document canonical
-- snapshot for aggregate-scoped work.
CREATE TABLE aggregate_state (
    aggregate_kind TEXT NOT NULL,
    aggregate_id TEXT NOT NULL,
    snapshot BLOB NOT NULL,
    snapshot_sha256 TEXT NOT NULL CHECK (length(snapshot_sha256) = 64),
    updated_at TEXT NOT NULL,
    PRIMARY KEY (aggregate_kind, aggregate_id)
);

-- Immutable content-addressed aggregate checkpoints seeded by migration.
CREATE TABLE aggregate_checkpoints (
    path TEXT PRIMARY KEY,
    aggregate_kind TEXT NOT NULL,
    aggregate_id TEXT NOT NULL,
    snapshot_sha256 TEXT NOT NULL CHECK (length(snapshot_sha256) = 64),
    checkpoint_json TEXT NOT NULL,
    created_at TEXT NOT NULL
);

CREATE INDEX aggregate_checkpoints_aggregate
    ON aggregate_checkpoints(aggregate_kind, aggregate_id);

-- The single record binding retained v1 history to the v2 generation. Its
-- presence is what makes this installation an aggregate writer.
--
-- Only the exact protocol bytes are stored. The v1 checkpoint identity, the
-- catalogue hash, and the catalogue path are all derived from validated genesis
-- on read, so no denormalized copy can disagree with them.
CREATE TABLE aggregate_migration (
    singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
    library_id TEXT NOT NULL,
    catalogue_json TEXT NOT NULL,
    genesis_json TEXT NOT NULL,
    barrier_device_id TEXT NOT NULL,
    barrier_sequence TEXT NOT NULL CHECK (length(barrier_sequence) = 20),
    migrated_at TEXT NOT NULL,
    FOREIGN KEY (barrier_device_id, barrier_sequence)
        REFERENCES batches(device_id, sequence)
);
