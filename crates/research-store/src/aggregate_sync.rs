//! Transport for aggregate-scoped operations.
//!
//! This is the v2 counterpart to the protocol-v1 batch queue. It is kept
//! separate because the unit of work is different: a v1 operation addresses the
//! whole library, while a v2 operation addresses one aggregate, and only that
//! aggregate's replica is loaded to apply it.
//!
//! Applying is allowed to decline. An operation whose causal dependency has not
//! arrived is reported as deferred and nothing is written — not the replica, not
//! the batch record, not the remote observation — so the caller can retry it
//! once its dependency lands. Recording it as applied would be a silent loss:
//! Loro keeps the pending update in memory, but the snapshot this store
//! persists would not carry it.

use research_domain::{AggregateEnvelope, AggregateKind, ItemAggregate, ZenAggregate};
use sqlx::{Row, SqliteConnection};

use crate::store::{now_rfc3339, peer_id_for_device, sha256_hex};
use crate::zen::persist_zen_projection;
use crate::{StoreError, StoreResult, V2Store};

/// One aggregate operation awaiting upload.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct PendingAggregateOperation {
    pub path: String,
    pub envelope_json: String,
}

/// What receiving an aggregate operation did.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum AggregateDisposition {
    Applied,
    AlreadyApplied,
    /// Waiting on an operation this device has not applied yet.
    Deferred,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct RemoteAggregateResult {
    pub disposition: AggregateDisposition,
    /// True when this operation was one of ours coming back, which is the only
    /// proof an upload is durable on the remote.
    pub acknowledged_outbox: bool,
}

impl V2Store {
    /// Operations queued for upload, oldest first within each aggregate.
    ///
    /// Ordered by device and sequence so a receiver never has to wait on an
    /// operation that was uploaded later than the one depending on it.
    pub async fn pending_aggregate_operations(
        &self,
    ) -> StoreResult<Vec<PendingAggregateOperation>> {
        let rows = sqlx::query(
            "SELECT b.path, b.envelope_json FROM aggregate_outbox o \
             JOIN aggregate_batches b ON b.aggregate_kind = o.aggregate_kind \
             AND b.aggregate_id = o.aggregate_id AND b.device_id = o.device_id \
             AND b.sequence = o.sequence \
             ORDER BY o.device_id ASC, o.sequence ASC",
        )
        .fetch_all(&self.pool)
        .await?;
        rows.into_iter()
            .map(|row| {
                Ok(PendingAggregateOperation {
                    path: row.try_get("path")?,
                    envelope_json: row.try_get("envelope_json")?,
                })
            })
            .collect()
    }

    pub async fn pending_aggregate_operation_count(&self) -> StoreResult<u64> {
        let count: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM aggregate_outbox")
            .fetch_one(&self.pool)
            .await?;
        u64::try_from(count).map_err(|_| StoreError::NumericRange("pending aggregate count"))
    }

    pub async fn record_aggregate_outbox_attempt(
        &self,
        path: &str,
        error_kind: Option<&str>,
    ) -> StoreResult<()> {
        sqlx::query(
            "UPDATE aggregate_outbox SET attempts = attempts + 1, last_error = ? \
             WHERE EXISTS (SELECT 1 FROM aggregate_batches b \
             WHERE b.aggregate_kind = aggregate_outbox.aggregate_kind \
             AND b.aggregate_id = aggregate_outbox.aggregate_id \
             AND b.device_id = aggregate_outbox.device_id \
             AND b.sequence = aggregate_outbox.sequence AND b.path = ?)",
        )
        .bind(error_kind)
        .bind(path)
        .execute(&self.pool)
        .await?;
        Ok(())
    }

    /// Applies one remote aggregate operation, or declines it.
    ///
    /// The whole effect is one transaction: replica, projection, batch record,
    /// outbox acknowledgement, and remote observation land together or not at
    /// all.
    pub async fn receive_remote_aggregate_operation(
        &self,
        path: &str,
        blob_sha: &str,
        bytes: &[u8],
    ) -> StoreResult<RemoteAggregateResult> {
        let envelope: AggregateEnvelope = serde_json::from_slice(bytes)
            .map_err(|_| StoreError::SyncIntegrity(format!("{path} is not a v2 envelope")))?;
        let library_id = self.meta("library_id").await?;
        let local_device_id = self.meta("device_id").await?;
        let peer_id = peer_id_for_device(&local_device_id)?;
        // Fails closed on a kind this build does not implement: skipping the
        // operation would materialize a library missing part of its history.
        envelope.aggregate_kind.path_segment()?;
        if envelope.path()? != path {
            return Err(StoreError::SyncIntegrity(format!(
                "{path} does not address the operation it contains"
            )));
        }

        let mut connection = self.pool.acquire().await?;
        sqlx::query("BEGIN IMMEDIATE")
            .execute(&mut *connection)
            .await?;
        let result = async {
            let known: Option<String> = sqlx::query_scalar(
                "SELECT path FROM aggregate_batches WHERE aggregate_kind = ? \
                 AND aggregate_id = ? AND device_id = ? AND sequence = ?",
            )
            .bind(envelope.aggregate_kind.as_str())
            .bind(&envelope.aggregate_id)
            .bind(&envelope.device_id)
            .bind(&envelope.sequence)
            .fetch_optional(&mut *connection)
            .await?;

            let disposition = if known.is_some() {
                AggregateDisposition::AlreadyApplied
            } else if apply_aggregate(&mut connection, path, &envelope, &library_id, peer_id)
                .await?
            {
                record_aggregate_batch(&mut connection, path, &envelope, bytes).await?;
                AggregateDisposition::Applied
            } else {
                AggregateDisposition::Deferred
            };

            if disposition == AggregateDisposition::Deferred {
                return Ok(RemoteAggregateResult {
                    disposition,
                    acknowledged_outbox: false,
                });
            }

            let acknowledged = sqlx::query(
                "DELETE FROM aggregate_outbox WHERE aggregate_kind = ? AND aggregate_id = ? \
                 AND device_id = ? AND sequence = ?",
            )
            .bind(envelope.aggregate_kind.as_str())
            .bind(&envelope.aggregate_id)
            .bind(&envelope.device_id)
            .bind(&envelope.sequence)
            .execute(&mut *connection)
            .await?
            .rows_affected()
                > 0;
            observe_aggregate_blob(&mut connection, path, blob_sha).await?;
            Ok(RemoteAggregateResult {
                disposition,
                acknowledged_outbox: acknowledged,
            })
        }
        .await;
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
}

/// Applies an operation to its aggregate's replica.
///
/// Returns `false` when the operation was deferred, leaving every table
/// untouched.
async fn apply_aggregate(
    connection: &mut SqliteConnection,
    path: &str,
    envelope: &AggregateEnvelope,
    library_id: &str,
    peer_id: u64,
) -> StoreResult<bool> {
    let kind = envelope.aggregate_kind.as_str();
    let existing: Option<Vec<u8>> = sqlx::query_scalar(
        "SELECT snapshot FROM aggregate_state WHERE aggregate_kind = ? AND aggregate_id = ?",
    )
    .bind(kind)
    .bind(&envelope.aggregate_id)
    .fetch_optional(&mut *connection)
    .await?;
    let now = now_rfc3339();

    match envelope.aggregate_kind {
        AggregateKind::Zen => {
            let aggregate = match existing {
                Some(snapshot) => {
                    let aggregate = ZenAggregate::from_snapshot(
                        &envelope.aggregate_id,
                        &snapshot,
                        peer_id,
                    )?;
                    if aggregate.import_envelope(path, envelope, library_id)? {
                        return Ok(false);
                    }
                    aggregate
                }
                None => {
                    match ZenAggregate::from_envelope(path, envelope, library_id, peer_id)? {
                        Some(aggregate) => aggregate,
                        None => return Ok(false),
                    }
                }
            };
            write_replica(
                connection,
                kind,
                &envelope.aggregate_id,
                &aggregate.export_snapshot()?,
                &now,
            )
            .await?;
            persist_zen_projection(connection, &aggregate.view()?.summary(), &now).await?;
        }
        AggregateKind::Item => {
            // Item replicas are seeded by migration, so an operation for one
            // this device has never seen is waiting on the catalogue rather
            // than on another operation.
            let Some(snapshot) = existing else {
                return Ok(false);
            };
            let aggregate =
                ItemAggregate::from_snapshot(&envelope.aggregate_id, &snapshot, peer_id)?;
            if aggregate.import_envelope(path, envelope, library_id)? {
                return Ok(false);
            }
            write_replica(
                connection,
                kind,
                &envelope.aggregate_id,
                &aggregate.export_snapshot()?,
                &now,
            )
            .await?;
        }
        AggregateKind::Unsupported(ref value) => {
            return Err(
                research_domain::DomainError::UnsupportedAggregateKind(value.clone()).into(),
            );
        }
    }
    Ok(true)
}

async fn write_replica(
    connection: &mut SqliteConnection,
    kind: &str,
    aggregate_id: &str,
    snapshot: &[u8],
    now: &str,
) -> StoreResult<()> {
    sqlx::query(
        "INSERT INTO aggregate_state \
         (aggregate_kind, aggregate_id, snapshot, snapshot_sha256, updated_at) \
         VALUES (?, ?, ?, ?, ?) \
         ON CONFLICT(aggregate_kind, aggregate_id) DO UPDATE SET \
         snapshot = excluded.snapshot, snapshot_sha256 = excluded.snapshot_sha256, \
         updated_at = excluded.updated_at",
    )
    .bind(kind)
    .bind(aggregate_id)
    .bind(snapshot)
    .bind(sha256_hex(snapshot))
    .bind(now)
    .execute(&mut *connection)
    .await?;
    Ok(())
}

async fn record_aggregate_batch(
    connection: &mut SqliteConnection,
    path: &str,
    envelope: &AggregateEnvelope,
    bytes: &[u8],
) -> StoreResult<()> {
    let envelope_json = std::str::from_utf8(bytes)
        .map_err(|_| StoreError::SyncIntegrity(format!("{path} is not UTF-8 JSON")))?;
    sqlx::query(
        "INSERT INTO aggregate_batches \
         (aggregate_kind, aggregate_id, device_id, sequence, path, payload_sha256, \
          envelope_json, origin, applied_at) \
         VALUES (?, ?, ?, ?, ?, ?, ?, 'remote', ?)",
    )
    .bind(envelope.aggregate_kind.as_str())
    .bind(&envelope.aggregate_id)
    .bind(&envelope.device_id)
    .bind(&envelope.sequence)
    .bind(path)
    .bind(&envelope.payload_sha256)
    .bind(envelope_json)
    .bind(now_rfc3339())
    .execute(&mut *connection)
    .await?;
    Ok(())
}

/// Records that an immutable v2 path was seen carrying exactly these bytes.
async fn observe_aggregate_blob(
    connection: &mut SqliteConnection,
    path: &str,
    blob_sha: &str,
) -> StoreResult<()> {
    sqlx::query(
        "INSERT OR IGNORE INTO remote_observations (path, blob_sha, observed_at) \
         VALUES (?, ?, ?)",
    )
    .bind(path)
    .bind(blob_sha)
    .bind(now_rfc3339())
    .execute(&mut *connection)
    .await?;
    Ok(())
}
