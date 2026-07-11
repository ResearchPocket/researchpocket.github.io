CREATE TABLE sync_config (
    singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
    repository_owner TEXT NOT NULL CHECK (length(repository_owner) > 0),
    repository_name TEXT NOT NULL CHECK (length(repository_name) > 0),
    branch TEXT NOT NULL CHECK (length(branch) > 0),
    configured_at TEXT NOT NULL,
    last_success_at TEXT,
    last_error_kind TEXT,
    last_error_at TEXT
);

CREATE TABLE remote_observations (
    path TEXT PRIMARY KEY,
    blob_sha TEXT NOT NULL CHECK (length(blob_sha) IN (40, 64)),
    observed_at TEXT NOT NULL
);

CREATE TABLE deferred_batches (
    device_id TEXT NOT NULL,
    sequence TEXT NOT NULL,
    PRIMARY KEY (device_id, sequence),
    FOREIGN KEY (device_id, sequence) REFERENCES batches(device_id, sequence) ON DELETE CASCADE
);
