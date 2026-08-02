//! Cutover from the single-document protocol-v1 library to item aggregates.
//!
//! Migration is a local, atomic, idempotent step. It retains every v1
//! operation, seeds one immutable checkpoint per item, and queues the recognized
//! v1 barrier operation that makes older clients stop before they can upload
//! into a generation they do not implement.

use base64::{Engine as _, engine::general_purpose::STANDARD};
use research_domain::{
    AggregateGenesis, AggregateKind, ItemAggregateCheckpoint, Library,
    aggregate_catalogue_path, create_aggregate_migration,
};
use sqlx::{Row, SqliteConnection};

use crate::mutation::enqueue_local_envelope;
use crate::store::{now_rfc3339, peer_id_for_device, sha256_hex};
use crate::sync::build_checkpoint_candidate;
use crate::{StoreError, StoreResult, V2Store};

/// What a migration produced, or found already recorded.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct AggregateMigrationReceipt {
    pub library_id: String,
    pub v1_checkpoint_id: String,
    pub catalogue_path: String,
    pub catalogue_sha256: String,
    /// Absent when this device adopted a generation another device published:
    /// only the migrating device writes the v1 barrier.
    pub barrier_path: Option<String>,
    pub aggregate_count: usize,
    /// True when this call found an existing record and changed nothing.
    pub already_migrated: bool,
}

/// The exact protocol bytes of a v2 generation, ready to publish or compare.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct AggregateGeneration {
    pub genesis_json: String,
    pub catalogue_json: String,
    pub catalogue_path: String,
}

impl V2Store {
    pub async fn aggregate_migration(&self) -> StoreResult<Option<AggregateMigrationReceipt>> {
        let mut connection = self.pool.acquire().await?;
        read_migration(&mut connection).await
    }

    /// The exact generation bytes this device would publish, if it has one.
    pub async fn aggregate_generation(&self) -> StoreResult<Option<AggregateGeneration>> {
        let Some(row) = sqlx::query(
            "SELECT library_id, catalogue_json, genesis_json FROM aggregate_migration \
             WHERE singleton = 1",
        )
        .fetch_optional(&self.pool)
        .await?
        else {
            return Ok(None);
        };
        let library_id: String = row.try_get("library_id")?;
        let catalogue_json: String = row.try_get("catalogue_json")?;
        let genesis_json: String = row.try_get("genesis_json")?;
        let genesis: AggregateGenesis = serde_json::from_str(&genesis_json)?;
        genesis.validate(&library_id, &catalogue_json)?;
        Ok(Some(AggregateGeneration {
            catalogue_path: aggregate_catalogue_path(&genesis.catalogue_sha256),
            genesis_json,
            catalogue_json,
        }))
    }

    /// Records a generation another device published.
    ///
    /// Genesis is immutable, so adopting the same bytes twice is a no-op and
    /// adopting different bytes is refused: two genesis artifacts for one
    /// library means the remote is not the history this device belongs to.
    /// Every identity is re-derived from the bytes, never from the caller.
    pub async fn adopt_aggregate_generation(
        &self,
        genesis_json: &str,
        catalogue_json: &str,
    ) -> StoreResult<AggregateMigrationReceipt> {
        let library_id = self.meta("library_id").await?;
        let genesis: AggregateGenesis = serde_json::from_str(genesis_json)?;
        genesis.validate(&library_id, catalogue_json)?;

        let mut connection = self.pool.acquire().await?;
        if let Some(existing) = read_migration(&mut connection).await? {
            if existing.catalogue_sha256 != genesis.catalogue_sha256 {
                return Err(StoreError::SyncIntegrity(
                    "the remote aggregate generation does not match the one this device \
                     already records"
                        .into(),
                ));
            }
            return Ok(existing);
        }
        sqlx::query(
            "INSERT INTO aggregate_migration \
             (singleton, library_id, catalogue_json, genesis_json, migrated_at) \
             VALUES (1, ?, ?, ?, ?)",
        )
        .bind(&library_id)
        .bind(catalogue_json)
        .bind(genesis_json)
        .bind(now_rfc3339())
        .execute(&mut *connection)
        .await?;
        read_migration(&mut connection).await?.ok_or_else(|| {
            StoreError::InvalidStore("adopted aggregate generation was not stored".into())
        })
    }

    /// Stores one aggregate checkpoint an adopted catalogue names.
    ///
    /// The artifact is validated into a live replica before anything is written,
    /// so a checkpoint that does not rebuild cannot seed local state.
    pub async fn receive_aggregate_checkpoint(
        &self,
        path: &str,
        checkpoint_json: &str,
    ) -> StoreResult<()> {
        let peer_id = peer_id_for_device(&self.meta("device_id").await?)?;
        let artifact: ItemAggregateCheckpoint = serde_json::from_str(checkpoint_json)?;
        artifact.validate(path, peer_id)?;
        let snapshot = STANDARD.decode(&artifact.snapshot_base64).map_err(|_| {
            StoreError::SyncIntegrity("aggregate checkpoint payload is not Base64".into())
        })?;
        let now = now_rfc3339();
        let mut connection = self.pool.acquire().await?;
        sqlx::query(
            "INSERT INTO aggregate_state \
             (aggregate_kind, aggregate_id, snapshot, snapshot_sha256, updated_at) \
             VALUES (?, ?, ?, ?, ?) \
             ON CONFLICT(aggregate_kind, aggregate_id) DO NOTHING",
        )
        .bind(AggregateKind::Item.as_str())
        .bind(&artifact.aggregate_id)
        .bind(&snapshot)
        .bind(&artifact.snapshot_sha256)
        .bind(&now)
        .execute(&mut *connection)
        .await?;
        sqlx::query(
            "INSERT INTO aggregate_checkpoints \
             (path, aggregate_kind, aggregate_id, snapshot_sha256, checkpoint_json, created_at) \
             VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT(path) DO NOTHING",
        )
        .bind(path)
        .bind(AggregateKind::Item.as_str())
        .bind(&artifact.aggregate_id)
        .bind(&artifact.snapshot_sha256)
        .bind(checkpoint_json)
        .bind(&now)
        .execute(&mut *connection)
        .await?;
        Ok(())
    }

    /// Checkpoints this device holds, for publication.
    pub async fn aggregate_checkpoints(&self) -> StoreResult<Vec<(String, String)>> {
        let rows = sqlx::query(
            "SELECT path, checkpoint_json FROM aggregate_checkpoints ORDER BY path ASC",
        )
        .fetch_all(&self.pool)
        .await?;
        rows.into_iter()
            .map(|row| Ok((row.try_get("path")?, row.try_get("checkpoint_json")?)))
            .collect()
    }

    /// Aggregate IDs already present locally, so adoption downloads only what
    /// is missing rather than every checkpoint in the catalogue.
    pub async fn known_aggregate_ids(&self, kind: &AggregateKind) -> StoreResult<Vec<String>> {
        Ok(sqlx::query_scalar(
            "SELECT aggregate_id FROM aggregate_state WHERE aggregate_kind = ?",
        )
        .bind(kind.as_str())
        .fetch_all(&self.pool)
        .await?)
    }

    /// Move this installation onto the item-aggregates-v2 generation.
    ///
    /// Repeating the call is a no-op that returns the recorded receipt, so a
    /// crash between the commit and any later upload cannot produce a second,
    /// differently-identified migration.
    pub async fn migrate_to_item_aggregates(&self) -> StoreResult<AggregateMigrationReceipt> {
        let mut connection = self.pool.acquire().await?;
        sqlx::query("BEGIN IMMEDIATE")
            .execute(&mut *connection)
            .await?;
        let result = run_migration(&mut connection).await;
        match result {
            Ok(receipt) => {
                sqlx::query("COMMIT").execute(&mut *connection).await?;
                Ok(receipt)
            }
            Err(error) => {
                let _ = sqlx::query("ROLLBACK").execute(&mut *connection).await;
                Err(error)
            }
        }
    }
}

async fn read_migration(
    connection: &mut SqliteConnection,
) -> StoreResult<Option<AggregateMigrationReceipt>> {
    let Some(row) = sqlx::query(
        "SELECT library_id, catalogue_json, genesis_json, barrier_device_id, barrier_sequence \
         FROM aggregate_migration WHERE singleton = 1",
    )
    .fetch_optional(&mut *connection)
    .await?
    else {
        return Ok(None);
    };
    let library_id: String = row.try_get("library_id")?;
    let catalogue_json: String = row.try_get("catalogue_json")?;
    let genesis_json: String = row.try_get("genesis_json")?;
    let device_id: Option<String> = row.try_get("barrier_device_id")?;
    let sequence: Option<String> = row.try_get("barrier_sequence")?;
    // Reading revalidates rather than trusting local bytes, so a corrupt row
    // cannot report a migration whose identities do not hold.
    let genesis: AggregateGenesis = serde_json::from_str(&genesis_json)?;
    let catalogue = genesis.validate(&library_id, &catalogue_json)?;
    Ok(Some(AggregateMigrationReceipt {
        library_id,
        v1_checkpoint_id: genesis.migrated_from_v1_checkpoint,
        catalogue_path: aggregate_catalogue_path(&genesis.catalogue_sha256),
        catalogue_sha256: genesis.catalogue_sha256,
        barrier_path: device_id
            .zip(sequence)
            .map(|(device, sequence)| format!("sync/v1/ops/{device}/{sequence}.json")),
        aggregate_count: catalogue.entries.len(),
        already_migrated: true,
    }))
}

async fn run_migration(
    connection: &mut SqliteConnection,
) -> StoreResult<AggregateMigrationReceipt> {
    if let Some(existing) = read_migration(&mut *connection).await? {
        return Ok(existing);
    }
    // Unsent local work would have to be re-expressed as aggregate operations,
    // and unapplied remote work would migrate a library this device has not
    // fully observed. Both are refused rather than guessed at.
    let (queued, deferred): (i64, i64) = sqlx::query_as(
        "SELECT (SELECT COUNT(*) FROM outbox), (SELECT COUNT(*) FROM deferred_batches)",
    )
    .fetch_one(&mut *connection)
    .await?;
    if queued != 0 {
        return Err(StoreError::InvalidInput(
            "synchronize pending local changes before migrating to item aggregates".into(),
        ));
    }
    if deferred != 0 {
        return Err(StoreError::InvalidInput(
            "apply deferred remote updates before migrating to item aggregates".into(),
        ));
    }

    let library_id: String =
        sqlx::query_scalar("SELECT value FROM store_meta WHERE key = 'library_id'")
            .fetch_one(&mut *connection)
            .await?;
    let device_id: String =
        sqlx::query_scalar("SELECT value FROM store_meta WHERE key = 'device_id'")
            .fetch_one(&mut *connection)
            .await?;
    let peer_id = peer_id_for_device(&device_id)?;

    // The canonical v1 checkpoint this generation is derived from. Forcing it
    // ignores the ordinary tail thresholds: the identity, not the size saving,
    // is what genesis records.
    let checkpoint = build_checkpoint_candidate(&mut *connection, true)
        .await?
        .ok_or_else(|| {
            StoreError::InvalidInput(
                "migrate to item aggregates after this library has at least one operation"
                    .to_owned(),
            )
        })?;

    let now = now_rfc3339();
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
    let library = Library::from_snapshot(&snapshot, peer_id)?;
    let projection = library.canonical_projection()?;

    // The barrier carries no domain change; its whole payload is the required
    // feature that an older reader refuses.
    let sequence_text: String =
        sqlx::query_scalar("SELECT next_sequence FROM devices WHERE device_id = ?")
            .bind(&device_id)
            .fetch_one(&mut *connection)
            .await?;
    let sequence = sequence_text
        .parse::<u64>()
        .map_err(|_| StoreError::InvalidStore("invalid device sequence".into()))?;
    let barrier = library.export_item_aggregates_migration_barrier(
        &library.version(),
        &library_id,
        &device_id,
        sequence,
        &now,
    )?;
    let barrier_path = barrier.path();
    enqueue_local_envelope(&mut *connection, &barrier, &now).await?;

    let migration = create_aggregate_migration(
        &projection,
        &library_id,
        &checkpoint.checkpoint_id,
        &now,
        peer_id,
    )?;
    let genesis: AggregateGenesis = serde_json::from_str(&migration.genesis_json)?;
    // Validating what was just built keeps an unreadable artifact from being
    // committed and then uploaded.
    genesis.validate(&library_id, &migration.catalogue_json)?;

    for (path, checkpoint_json) in &migration.checkpoints {
        let artifact: ItemAggregateCheckpoint = serde_json::from_str(checkpoint_json)?;
        let aggregate_snapshot = STANDARD.decode(&artifact.snapshot_base64).map_err(|_| {
            StoreError::SyncIntegrity("aggregate checkpoint payload is not Base64".into())
        })?;
        sqlx::query(
            "INSERT INTO aggregate_state \
             (aggregate_kind, aggregate_id, snapshot, snapshot_sha256, updated_at) \
             VALUES (?, ?, ?, ?, ?)",
        )
        .bind(AggregateKind::Item.as_str())
        .bind(&artifact.aggregate_id)
        .bind(&aggregate_snapshot)
        .bind(&artifact.snapshot_sha256)
        .bind(&now)
        .execute(&mut *connection)
        .await?;
        sqlx::query(
            "INSERT INTO aggregate_checkpoints \
             (path, aggregate_kind, aggregate_id, snapshot_sha256, checkpoint_json, created_at) \
             VALUES (?, ?, ?, ?, ?, ?)",
        )
        .bind(path)
        .bind(AggregateKind::Item.as_str())
        .bind(&artifact.aggregate_id)
        .bind(&artifact.snapshot_sha256)
        .bind(checkpoint_json)
        .bind(&now)
        .execute(&mut *connection)
        .await?;
    }

    sqlx::query(
        "INSERT INTO aggregate_migration \
         (singleton, library_id, catalogue_json, genesis_json, barrier_device_id, \
          barrier_sequence, migrated_at) \
         VALUES (1, ?, ?, ?, ?, ?, ?)",
    )
    .bind(&library_id)
    .bind(&migration.catalogue_json)
    .bind(&migration.genesis_json)
    .bind(&barrier.device_id)
    .bind(&barrier.sequence)
    .bind(&now)
    .execute(&mut *connection)
    .await?;

    Ok(AggregateMigrationReceipt {
        library_id,
        v1_checkpoint_id: checkpoint.checkpoint_id,
        catalogue_path: aggregate_catalogue_path(&migration.catalogue_sha256),
        catalogue_sha256: migration.catalogue_sha256,
        barrier_path: Some(barrier_path),
        aggregate_count: migration.checkpoints.len(),
        already_migrated: false,
    })
}
