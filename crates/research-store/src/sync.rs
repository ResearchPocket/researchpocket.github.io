use chrono::{DateTime, FixedOffset};
use research_domain::{Library, LibraryGenesis, UpdateEnvelope};
use sqlx::{Row, SqliteConnection};

use crate::import::persist_projection;
use crate::store::{fresh_peer_id, now_rfc3339, sha256_hex};
use crate::{
    PendingBatch, RemoteBatchDisposition, RemoteBatchResult, StoreError, StoreResult,
    SyncConfiguration, SyncIdentity, V2Store,
};

impl V2Store {
    pub async fn sync_identity(&self) -> StoreResult<SyncIdentity> {
        Ok(SyncIdentity {
            library_id: self.meta("library_id").await?,
            device_id: self.meta("device_id").await?,
            pristine: self.is_pristine().await?,
        })
    }

    pub async fn sync_genesis(&self) -> StoreResult<LibraryGenesis> {
        Ok(LibraryGenesis::new(
            &self.meta("library_id").await?,
            &now_rfc3339(),
        )?)
    }

    pub async fn sync_configuration(&self) -> StoreResult<Option<SyncConfiguration>> {
        let row = sqlx::query(
            "SELECT repository_owner, repository_name, branch, configured_at, \
             last_success_at, last_error_kind, last_error_at \
             FROM sync_config WHERE singleton = 1",
        )
        .fetch_optional(&self.pool)
        .await?;
        row.map(|row| {
            Ok(SyncConfiguration {
                owner: row.try_get("repository_owner")?,
                repository: row.try_get("repository_name")?,
                branch: row.try_get("branch")?,
                configured_at: row.try_get("configured_at")?,
                last_success_at: row.try_get("last_success_at")?,
                last_error_kind: row.try_get("last_error_kind")?,
                last_error_at: row.try_get("last_error_at")?,
            })
        })
        .transpose()
    }

    pub async fn configure_sync(
        &self,
        owner: &str,
        repository: &str,
        branch: &str,
    ) -> StoreResult<SyncConfiguration> {
        for (label, value) in [
            ("repository owner", owner),
            ("repository name", repository),
            ("branch", branch),
        ] {
            if value.trim().is_empty() {
                return Err(StoreError::InvalidInput(format!("{label} cannot be blank")));
            }
        }
        if let Some(existing) = self.sync_configuration().await? {
            if existing.owner == owner
                && existing.repository == repository
                && existing.branch == branch
            {
                return Ok(existing);
            }
            return Err(StoreError::InvalidInput(
                "this library is already connected to another synchronization remote".into(),
            ));
        }
        let now = now_rfc3339();
        sqlx::query(
            "INSERT INTO sync_config \
             (singleton, repository_owner, repository_name, branch, configured_at) \
             VALUES (1, ?, ?, ?, ?)",
        )
        .bind(owner)
        .bind(repository)
        .bind(branch)
        .bind(&now)
        .execute(&self.pool)
        .await?;
        self.sync_configuration()
            .await?
            .ok_or(StoreError::SyncNotConfigured)
    }

    pub async fn adopt_library_id_if_pristine(
        &self,
        remote_library_id: &str,
    ) -> StoreResult<bool> {
        LibraryGenesis::new(remote_library_id, &now_rfc3339())?;
        let mut connection = self.pool.acquire().await?;
        sqlx::query("BEGIN IMMEDIATE")
            .execute(&mut *connection)
            .await?;
        let result = adopt_library_id(&mut connection, remote_library_id).await;
        match result {
            Ok(adopted) => {
                sqlx::query("COMMIT").execute(&mut *connection).await?;
                Ok(adopted)
            }
            Err(error) => {
                let _ = sqlx::query("ROLLBACK").execute(&mut *connection).await;
                Err(error)
            }
        }
    }

    pub async fn pending_batches(&self) -> StoreResult<Vec<PendingBatch>> {
        let rows = sqlx::query(
            "SELECT b.device_id, b.sequence, b.path, b.payload_sha256, b.envelope_json, \
             o.attempts FROM outbox o JOIN batches b USING (device_id, sequence) \
             ORDER BY o.enqueued_at ASC, b.device_id ASC, b.sequence ASC",
        )
        .fetch_all(&self.pool)
        .await?;
        rows.into_iter()
            .map(|row| {
                let attempts: i64 = row.try_get("attempts")?;
                Ok(PendingBatch {
                    device_id: row.try_get("device_id")?,
                    sequence: row.try_get("sequence")?,
                    path: row.try_get("path")?,
                    payload_sha256: row.try_get("payload_sha256")?,
                    envelope_json: row.try_get("envelope_json")?,
                    attempts: u64::try_from(attempts)
                        .map_err(|_| StoreError::NumericRange("outbox attempts"))?,
                })
            })
            .collect()
    }

    pub async fn remote_blob_is_current(
        &self,
        path: &str,
        blob_sha: &str,
    ) -> StoreResult<bool> {
        let observed = self.observed_remote_blob(path).await?;
        Ok(observed.as_deref() == Some(blob_sha))
    }

    pub async fn observed_remote_blob(&self, path: &str) -> StoreResult<Option<String>> {
        Ok(
            sqlx::query_scalar("SELECT blob_sha FROM remote_observations WHERE path = ?")
                .bind(path)
                .fetch_optional(&self.pool)
                .await?,
        )
    }

    pub async fn record_immutable_remote_blob(
        &self,
        path: &str,
        blob_sha: &str,
    ) -> StoreResult<()> {
        validate_blob_sha(blob_sha)?;
        sqlx::query(
            "INSERT OR IGNORE INTO remote_observations (path, blob_sha, observed_at) \
             VALUES (?, ?, ?)",
        )
        .bind(path)
        .bind(blob_sha)
        .bind(now_rfc3339())
        .execute(&self.pool)
        .await?;
        let observed = self.observed_remote_blob(path).await?.ok_or_else(|| {
            StoreError::InvalidStore("remote observation was not stored".into())
        })?;
        if observed != blob_sha {
            return Err(StoreError::SyncIntegrity(
                "an immutable remote path changed after it was observed".into(),
            ));
        }
        Ok(())
    }

    pub async fn receive_remote_batch(
        &self,
        path: &str,
        blob_sha: &str,
        bytes: &[u8],
    ) -> StoreResult<RemoteBatchResult> {
        validate_blob_sha(blob_sha)?;
        let envelope_json = std::str::from_utf8(bytes)
            .map_err(|_| StoreError::SyncIntegrity(format!("{path} is not UTF-8 JSON")))?;
        let envelope: UpdateEnvelope = serde_json::from_slice(bytes)?;
        let library_id = self.meta("library_id").await?;
        envelope.validate_identity(&library_id, path)?;
        validate_timestamp(&envelope.created_at, "operation creation time")?;

        let mut connection = self.pool.acquire().await?;
        sqlx::query("BEGIN IMMEDIATE")
            .execute(&mut *connection)
            .await?;
        let result =
            apply_remote_batch(&mut connection, path, blob_sha, envelope_json, &envelope).await;
        match result {
            Ok(result) => {
                sqlx::query("COMMIT").execute(&mut *connection).await?;
                Ok(result)
            }
            Err(error) => {
                let _ = sqlx::query("ROLLBACK").execute(&mut *connection).await;
                Err(error)
            }
        }
    }

    pub async fn record_outbox_attempt(
        &self,
        path: &str,
        error_kind: Option<&str>,
    ) -> StoreResult<()> {
        if let Some(kind) = error_kind {
            validate_error_kind(kind)?;
        }
        sqlx::query(
            "UPDATE outbox SET attempts = attempts + 1, last_error = ? \
             WHERE EXISTS (SELECT 1 FROM batches b WHERE b.device_id = outbox.device_id \
             AND b.sequence = outbox.sequence AND b.path = ?)",
        )
        .bind(error_kind)
        .bind(path)
        .execute(&self.pool)
        .await?;
        Ok(())
    }

    pub async fn record_sync_success(&self) -> StoreResult<()> {
        let result = sqlx::query(
            "UPDATE sync_config SET last_success_at = ?, last_error_kind = NULL, \
             last_error_at = NULL WHERE singleton = 1",
        )
        .bind(now_rfc3339())
        .execute(&self.pool)
        .await?;
        if result.rows_affected() != 1 {
            return Err(StoreError::SyncNotConfigured);
        }
        Ok(())
    }

    pub async fn record_sync_failure(&self, error_kind: &str) -> StoreResult<()> {
        validate_error_kind(error_kind)?;
        sqlx::query(
            "UPDATE sync_config SET last_error_kind = ?, last_error_at = ? \
             WHERE singleton = 1",
        )
        .bind(error_kind)
        .bind(now_rfc3339())
        .execute(&self.pool)
        .await?;
        Ok(())
    }

    async fn is_pristine(&self) -> StoreResult<bool> {
        let count: i64 = sqlx::query_scalar(
            "SELECT (SELECT COUNT(*) FROM batches) + (SELECT COUNT(*) FROM items) + \
             (SELECT COUNT(*) FROM import_rows) + (SELECT COUNT(*) FROM outbox)",
        )
        .fetch_one(&self.pool)
        .await?;
        Ok(count == 0)
    }
}

async fn adopt_library_id(
    connection: &mut SqliteConnection,
    remote_library_id: &str,
) -> StoreResult<bool> {
    let current: String =
        sqlx::query_scalar("SELECT value FROM store_meta WHERE key = 'library_id'")
            .fetch_one(&mut *connection)
            .await?;
    if current == remote_library_id {
        return Ok(false);
    }
    let count: i64 = sqlx::query_scalar(
        "SELECT (SELECT COUNT(*) FROM batches) + (SELECT COUNT(*) FROM items) + \
         (SELECT COUNT(*) FROM import_rows) + (SELECT COUNT(*) FROM outbox)",
    )
    .fetch_one(&mut *connection)
    .await?;
    let next_sequence: String = sqlx::query_scalar(
        "SELECT next_sequence FROM devices WHERE device_id = \
         (SELECT value FROM store_meta WHERE key = 'device_id')",
    )
    .fetch_one(&mut *connection)
    .await?;
    if count != 0 || next_sequence != "00000000000000000001" {
        return Err(StoreError::SyncLibraryMismatch(
            remote_library_id.to_owned(),
        ));
    }
    sqlx::query("UPDATE store_meta SET value = ? WHERE key = 'library_id'")
        .bind(remote_library_id)
        .execute(&mut *connection)
        .await?;
    Ok(true)
}

async fn apply_remote_batch(
    connection: &mut SqliteConnection,
    path: &str,
    blob_sha: &str,
    envelope_json: &str,
    envelope: &UpdateEnvelope,
) -> StoreResult<RemoteBatchResult> {
    let existing = sqlx::query(
        "SELECT envelope_json, payload_sha256 FROM batches \
         WHERE device_id = ? AND sequence = ?",
    )
    .bind(&envelope.device_id)
    .bind(&envelope.sequence)
    .fetch_optional(&mut *connection)
    .await?;
    if let Some(existing) = existing {
        let stored_json: String = existing.try_get("envelope_json")?;
        let stored_payload_sha256: String = existing.try_get("payload_sha256")?;
        if stored_json.as_bytes() != envelope_json.as_bytes()
            || stored_payload_sha256 != envelope.payload_sha256
        {
            return Err(StoreError::SyncIntegrity(format!(
                "batch identity collision at {path}"
            )));
        }
        observe_remote(connection, path, blob_sha).await?;
        let acknowledged_outbox = remove_outbox(connection, envelope).await?;
        return Ok(RemoteBatchResult {
            disposition: RemoteBatchDisposition::AlreadyApplied,
            acknowledged_outbox,
        });
    }

    let state = sqlx::query(
        "SELECT snapshot, snapshot_sha256 FROM canonical_state WHERE singleton = 1",
    )
    .fetch_one(&mut *connection)
    .await?;
    let snapshot: Vec<u8> = state.try_get("snapshot")?;
    let expected_snapshot_sha256: String = state.try_get("snapshot_sha256")?;
    if sha256_hex(&snapshot) != expected_snapshot_sha256 {
        return Err(StoreError::InvalidStore(
            "canonical snapshot checksum mismatch".into(),
        ));
    }
    let library = Library::from_snapshot(&snapshot, fresh_peer_id())?;
    let incoming_pending = library.import_envelope_has_pending(envelope)?;
    // A Loro snapshot does not retain an update whose causal predecessor was
    // absent when that snapshot was exported. Receipted immutable envelopes do
    // retain it. Replay only the explicitly deferred tail; once a predecessor
    // arrives, previously deferred effects materialize in this transaction.
    let deferred = sqlx::query(
        "SELECT b.device_id, b.sequence, b.envelope_json FROM deferred_batches d \
         JOIN batches b USING (device_id, sequence) \
         ORDER BY b.device_id ASC, b.sequence ASC",
    )
    .fetch_all(&mut *connection)
    .await?;
    for row in deferred {
        let device_id: String = row.try_get("device_id")?;
        let sequence: String = row.try_get("sequence")?;
        let stored_json: String = row.try_get("envelope_json")?;
        let stored: UpdateEnvelope = serde_json::from_str(&stored_json)?;
        if !library.import_envelope_has_pending(&stored)? {
            sqlx::query("DELETE FROM deferred_batches WHERE device_id = ? AND sequence = ?")
                .bind(device_id)
                .bind(sequence)
                .execute(&mut *connection)
                .await?;
        }
    }
    let new_snapshot = library.export_snapshot()?;
    let projection = library.canonical_projection()?;
    let now = now_rfc3339();
    persist_projection(connection, &projection).await?;
    sqlx::query(
        "UPDATE canonical_state SET snapshot = ?, snapshot_sha256 = ?, updated_at = ? \
         WHERE singleton = 1",
    )
    .bind(&new_snapshot)
    .bind(sha256_hex(&new_snapshot))
    .bind(&now)
    .execute(&mut *connection)
    .await?;
    sqlx::query(
        "INSERT INTO batches \
         (device_id, sequence, payload_sha256, protocol_version, library_id, path, \
          envelope_json, origin, applied_at) \
         VALUES (?, ?, ?, ?, ?, ?, ?, 'remote', ?)",
    )
    .bind(&envelope.device_id)
    .bind(&envelope.sequence)
    .bind(&envelope.payload_sha256)
    .bind(i64::from(envelope.protocol_version))
    .bind(&envelope.library_id)
    .bind(path)
    .bind(envelope_json)
    .bind(&now)
    .execute(&mut *connection)
    .await?;
    if incoming_pending {
        sqlx::query("INSERT INTO deferred_batches (device_id, sequence) VALUES (?, ?)")
            .bind(&envelope.device_id)
            .bind(&envelope.sequence)
            .execute(&mut *connection)
            .await?;
    }
    observe_remote(connection, path, blob_sha).await?;
    Ok(RemoteBatchResult {
        disposition: RemoteBatchDisposition::Applied,
        acknowledged_outbox: false,
    })
}

async fn observe_remote(
    connection: &mut SqliteConnection,
    path: &str,
    blob_sha: &str,
) -> StoreResult<()> {
    sqlx::query(
        "INSERT INTO remote_observations (path, blob_sha, observed_at) VALUES (?, ?, ?) \
         ON CONFLICT(path) DO UPDATE SET blob_sha = excluded.blob_sha, \
         observed_at = excluded.observed_at",
    )
    .bind(path)
    .bind(blob_sha)
    .bind(now_rfc3339())
    .execute(&mut *connection)
    .await?;
    Ok(())
}

async fn remove_outbox(
    connection: &mut SqliteConnection,
    envelope: &UpdateEnvelope,
) -> StoreResult<bool> {
    let result = sqlx::query("DELETE FROM outbox WHERE device_id = ? AND sequence = ?")
        .bind(&envelope.device_id)
        .bind(&envelope.sequence)
        .execute(&mut *connection)
        .await?;
    Ok(result.rows_affected() == 1)
}

fn validate_timestamp(value: &str, label: &str) -> StoreResult<()> {
    let parsed: DateTime<FixedOffset> = DateTime::parse_from_rfc3339(value)
        .map_err(|_| StoreError::SyncIntegrity(format!("invalid {label}")))?;
    if parsed.offset().local_minus_utc() != 0 {
        return Err(StoreError::SyncIntegrity(format!("{label} is not in UTC")));
    }
    Ok(())
}

fn validate_blob_sha(blob_sha: &str) -> StoreResult<()> {
    if !matches!(blob_sha.len(), 40 | 64)
        || !blob_sha
            .bytes()
            .all(|byte| byte.is_ascii_digit() || matches!(byte, b'a'..=b'f'))
    {
        return Err(StoreError::SyncIntegrity(
            "remote blob has an invalid object ID".into(),
        ));
    }
    Ok(())
}

fn validate_error_kind(kind: &str) -> StoreResult<()> {
    if kind.is_empty()
        || kind.len() > 64
        || !kind
            .bytes()
            .all(|byte| byte.is_ascii_lowercase() || byte == b'_')
    {
        return Err(StoreError::InvalidInput(
            "sync error kind must be lowercase ASCII words".into(),
        ));
    }
    Ok(())
}
