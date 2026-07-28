CREATE TABLE checkpoints (
    path TEXT PRIMARY KEY,
    checkpoint_id TEXT NOT NULL UNIQUE CHECK (length(checkpoint_id) = 64),
    checkpoint_json TEXT NOT NULL,
    batch_count INTEGER NOT NULL CHECK (batch_count >= 0),
    coverage_json TEXT NOT NULL,
    created_at TEXT NOT NULL,
    origin TEXT NOT NULL CHECK (origin IN ('local', 'remote')),
    applied_at TEXT NOT NULL
);

CREATE TABLE checkpoint_coverage (
    checkpoint_path TEXT NOT NULL REFERENCES checkpoints(path) ON DELETE CASCADE,
    device_id TEXT NOT NULL,
    start_sequence TEXT NOT NULL CHECK (length(start_sequence) = 20),
    end_sequence TEXT NOT NULL CHECK (length(end_sequence) = 20),
    PRIMARY KEY (checkpoint_path, device_id, start_sequence)
);

CREATE TABLE selected_checkpoint (
    singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
    checkpoint_path TEXT NOT NULL REFERENCES checkpoints(path),
    selected_at TEXT NOT NULL
);
