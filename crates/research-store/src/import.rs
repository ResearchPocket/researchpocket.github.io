use std::collections::BTreeSet;
use std::fs;
use std::io::Read;
use std::path::{Path, PathBuf};

use chrono::DateTime;
use research_domain::{
    CanonicalItem, CanonicalProjection, ItemSeed, Library, LifecycleState, validate_item_url,
};
use serde::Serialize;
use sha2::{Digest, Sha256};
use sqlx::sqlite::SqliteConnectOptions;
use sqlx::{Connection, Row, SqliteConnection};
use tempfile::TempDir;
use uuid::Uuid;

use crate::store::{fresh_peer_id, now_rfc3339, sha256_hex};
use crate::{
    ImportRejection, ImportResult, SourceBundleReceipt, SourceFileReceipt, StoreError,
    StoreResult, V2Store,
};

const SOURCE_KIND: &str = "researchpocket_v1_sqlite";
const SIDECARS: [(&str, &str); 4] = [
    ("main", ""),
    ("wal", "-wal"),
    ("shm", "-shm"),
    ("journal", "-journal"),
];

struct StagedSource {
    _directory: TempDir,
    original: PathBuf,
    database: PathBuf,
    receipt: SourceBundleReceipt,
}

impl StagedSource {
    fn verify_unchanged(&self) -> StoreResult<()> {
        if inspect_bundle(&self.original)? != self.receipt {
            return Err(StoreError::SourceChanged);
        }
        Ok(())
    }
}

fn stage_source(source: &Path) -> StoreResult<StagedSource> {
    let original = source.to_path_buf();
    let before = inspect_bundle(&original)?;
    let directory = tempfile::Builder::new()
        .prefix("researchpocket-v1-")
        .tempdir()?;
    make_private(directory.path(), true)?;
    let database = directory.path().join("source.sqlite3");

    for receipt in &before.files {
        let suffix = role_suffix(&receipt.role)?;
        let source_file = path_with_suffix(&original, suffix);
        let staged_file = path_with_suffix(&database, suffix);
        fs::copy(&source_file, &staged_file)?;
        make_private(&staged_file, false)?;
        let (bytes, sha256) = hash_file(&staged_file)?;
        if bytes != receipt.bytes || sha256 != receipt.sha256 {
            return Err(StoreError::SourceChanged);
        }
    }

    if inspect_bundle(&original)? != before {
        return Err(StoreError::SourceChanged);
    }
    Ok(StagedSource {
        _directory: directory,
        original,
        database,
        receipt: before,
    })
}

fn inspect_bundle(database: &Path) -> StoreResult<SourceBundleReceipt> {
    let mut files = Vec::new();
    for (role, suffix) in SIDECARS {
        let path = path_with_suffix(database, suffix);
        if !path.exists() {
            if role == "main" {
                return Err(StoreError::InvalidV1Schema(
                    "source database does not exist".into(),
                ));
            }
            continue;
        }
        if !path.is_file() {
            return Err(StoreError::InvalidV1Schema(format!(
                "source {role} entry is not a regular file"
            )));
        }
        let (bytes, sha256) = hash_file(&path)?;
        files.push(SourceFileReceipt {
            role: role.to_owned(),
            bytes,
            sha256,
        });
    }
    let encoded = serde_json::to_vec(&files)?;
    Ok(SourceBundleReceipt {
        sha256: sha256_hex(&encoded),
        files,
    })
}

fn hash_file(path: &Path) -> StoreResult<(u64, String)> {
    let mut file = fs::File::open(path)?;
    let mut digest = Sha256::new();
    let mut bytes = 0_u64;
    let mut buffer = [0_u8; 64 * 1024];
    loop {
        let read = file.read(&mut buffer)?;
        if read == 0 {
            break;
        }
        digest.update(&buffer[..read]);
        bytes = bytes
            .checked_add(read as u64)
            .ok_or(StoreError::NumericRange("source size"))?;
    }
    Ok((bytes, hex_digest(digest.finalize().as_slice())))
}

fn hex_digest(bytes: &[u8]) -> String {
    bytes.iter().map(|byte| format!("{byte:02x}")).collect()
}

fn path_with_suffix(database: &Path, suffix: &str) -> PathBuf {
    let mut path = database.as_os_str().to_os_string();
    path.push(suffix);
    PathBuf::from(path)
}

fn role_suffix(role: &str) -> StoreResult<&'static str> {
    SIDECARS
        .iter()
        .find_map(|(candidate, suffix)| (*candidate == role).then_some(*suffix))
        .ok_or_else(|| StoreError::InvalidV1Schema("unknown source sidecar role".into()))
}

fn make_private(path: &Path, directory: bool) -> StoreResult<()> {
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let mode = if directory { 0o700 } else { 0o600 };
        fs::set_permissions(path, fs::Permissions::from_mode(mode))?;
    }
    #[cfg(not(unix))]
    let _ = directory;
    Ok(())
}

struct PreparedImport {
    rows: Vec<PreparedRow>,
    rejections: Vec<ImportRejection>,
    scanned: u64,
}

struct PreparedRow {
    legacy_id: i64,
    provider: String,
    row_identity: String,
    content_sha256: String,
    url: String,
    title: Option<String>,
    excerpt: Option<String>,
    favorite: bool,
    language: Option<String>,
    saved_at: i64,
    note: String,
    tags: Vec<String>,
}

#[derive(Serialize)]
struct LegacyContent<'a> {
    provider: &'a str,
    legacy_id: i64,
    url: &'a str,
    title: &'a Option<String>,
    excerpt: &'a Option<String>,
    favorite: bool,
    language: &'a Option<String>,
    saved_at: i64,
    note: &'a str,
    tags: &'a [String],
}

async fn read_source(database: &Path) -> StoreResult<PreparedImport> {
    let options = SqliteConnectOptions::new()
        .filename(database)
        .create_if_missing(false);
    let mut connection = SqliteConnection::connect_with(&options).await?;
    sqlx::query("PRAGMA query_only = ON")
        .execute(&mut connection)
        .await?;
    let has_notes = validate_v1_schema(&mut connection).await?;
    let source_rows = if has_notes {
        sqlx::query(
            "SELECT i.rowid AS source_rowid, i.id, i.uri, i.title, i.excerpt, \
             i.time_added, i.favorite, i.lang, i.provider_id, p.name AS provider, \
             i.notes AS notes \
             FROM items i LEFT JOIN providers p ON p.id = i.provider_id \
             ORDER BY i.rowid ASC",
        )
        .fetch_all(&mut connection)
        .await?
    } else {
        sqlx::query(
            "SELECT i.rowid AS source_rowid, i.id, i.uri, i.title, i.excerpt, \
             i.time_added, i.favorite, i.lang, i.provider_id, p.name AS provider, \
             NULL AS notes \
             FROM items i LEFT JOIN providers p ON p.id = i.provider_id \
             ORDER BY i.rowid ASC",
        )
        .fetch_all(&mut connection)
        .await?
    };
    let scanned = u64::try_from(source_rows.len())
        .map_err(|_| StoreError::NumericRange("source row count"))?;
    let mut rows = Vec::with_capacity(source_rows.len());
    let mut rejections = Vec::new();

    for source_row in source_rows {
        let locator = source_row
            .try_get::<i64, _>("id")
            .ok()
            .or_else(|| source_row.try_get::<i64, _>("source_rowid").ok());
        let legacy_id = match source_row.try_get::<i64, _>("id") {
            Ok(value) => value,
            Err(_) => {
                reject(&mut rejections, locator, "items.id", "invalid_integer");
                continue;
            }
        };
        let provider = match source_row.try_get::<Option<String>, _>("provider") {
            Ok(Some(value)) if !value.is_empty() => value,
            _ => {
                reject(
                    &mut rejections,
                    Some(legacy_id),
                    "items.provider_id",
                    "missing_provider",
                );
                continue;
            }
        };
        let url = match source_row.try_get::<String, _>("uri") {
            Ok(value) if is_supported_url(&value) => value,
            _ => {
                reject(
                    &mut rejections,
                    Some(legacy_id),
                    "items.uri",
                    "invalid_text",
                );
                continue;
            }
        };
        let title = match source_row.try_get::<Option<String>, _>("title") {
            Ok(value) => value,
            Err(_) => {
                reject(
                    &mut rejections,
                    Some(legacy_id),
                    "items.title",
                    "invalid_text",
                );
                continue;
            }
        };
        let excerpt = match source_row.try_get::<Option<String>, _>("excerpt") {
            Ok(value) => value,
            Err(_) => {
                reject(
                    &mut rejections,
                    Some(legacy_id),
                    "items.excerpt",
                    "invalid_text",
                );
                continue;
            }
        };
        let favorite = match source_row.try_get::<Option<i64>, _>("favorite") {
            Ok(Some(0)) => false,
            Ok(Some(1)) => true,
            _ => {
                reject(
                    &mut rejections,
                    Some(legacy_id),
                    "items.favorite",
                    "invalid_boolean",
                );
                continue;
            }
        };
        let language = match source_row.try_get::<Option<String>, _>("lang") {
            Ok(value) => value,
            Err(_) => {
                reject(
                    &mut rejections,
                    Some(legacy_id),
                    "items.lang",
                    "invalid_text",
                );
                continue;
            }
        };
        let saved_at = match source_row.try_get::<i64, _>("time_added") {
            Ok(value) if DateTime::from_timestamp(value, 0).is_some() => value,
            _ => {
                reject(
                    &mut rejections,
                    Some(legacy_id),
                    "items.time_added",
                    "invalid_timestamp",
                );
                continue;
            }
        };
        let note = match source_row.try_get::<Option<String>, _>("notes") {
            Ok(value) => value.unwrap_or_default(),
            Err(_) => {
                reject(
                    &mut rejections,
                    Some(legacy_id),
                    "items.notes",
                    "invalid_text",
                );
                continue;
            }
        };

        let tag_rows = sqlx::query(
            "SELECT tag_name FROM item_tags WHERE item_id = ? ORDER BY tag_name ASC",
        )
        .bind(legacy_id)
        .fetch_all(&mut connection)
        .await?;
        let mut tags = BTreeSet::new();
        for tag_row in tag_rows {
            match tag_row.try_get::<Option<String>, _>("tag_name") {
                Ok(Some(tag)) if !tag.trim().is_empty() => {
                    tags.insert(tag);
                }
                _ => reject(
                    &mut rejections,
                    Some(legacy_id),
                    "item_tags.tag_name",
                    "invalid_tag",
                ),
            }
        }
        let tags = tags.into_iter().collect::<Vec<_>>();
        let row_identity = legacy_row_identity(&provider, legacy_id, &url);
        let content_sha256 = sha256_hex(&serde_json::to_vec(&LegacyContent {
            provider: &provider,
            legacy_id,
            url: &url,
            title: &title,
            excerpt: &excerpt,
            favorite,
            language: &language,
            saved_at,
            note: &note,
            tags: &tags,
        })?);
        rows.push(PreparedRow {
            legacy_id,
            provider,
            row_identity,
            content_sha256,
            url,
            title,
            excerpt,
            favorite,
            language,
            saved_at,
            note,
            tags,
        });
    }
    connection.close().await?;
    Ok(PreparedImport {
        rows,
        rejections,
        scanned,
    })
}

async fn validate_v1_schema(connection: &mut SqliteConnection) -> StoreResult<bool> {
    for table in ["items", "providers", "tags", "item_tags"] {
        let exists: i64 = sqlx::query_scalar(
            "SELECT COUNT(*) FROM sqlite_master WHERE type = 'table' AND name = ?",
        )
        .bind(table)
        .fetch_one(&mut *connection)
        .await?;
        if exists != 1 {
            return Err(StoreError::InvalidV1Schema(format!(
                "required table {table} is missing"
            )));
        }
    }
    let columns = sqlx::query("SELECT name FROM pragma_table_info('items')")
        .fetch_all(&mut *connection)
        .await?
        .into_iter()
        .map(|row| row.try_get::<String, _>("name"))
        .collect::<Result<BTreeSet<_>, _>>()?;
    for column in [
        "id",
        "uri",
        "title",
        "excerpt",
        "time_added",
        "favorite",
        "lang",
        "provider_id",
    ] {
        if !columns.contains(column) {
            return Err(StoreError::InvalidV1Schema(format!(
                "required items column {column} is missing"
            )));
        }
    }
    Ok(columns.contains("notes"))
}

fn reject(
    rejections: &mut Vec<ImportRejection>,
    legacy_id: Option<i64>,
    field: &str,
    code: &str,
) {
    rejections.push(ImportRejection {
        legacy_id,
        field: field.to_owned(),
        code: code.to_owned(),
        reason: rejection_reason(code).to_owned(),
    });
}

fn rejection_reason(code: &str) -> &'static str {
    match code {
        "invalid_integer" => "required integer field is missing or invalid",
        "missing_provider" => "provider reference is missing or invalid",
        "invalid_text" => "text field is missing or has an invalid type",
        "invalid_boolean" => "favorite must be exactly zero or one",
        "invalid_timestamp" => "saved timestamp is missing or out of range",
        "invalid_tag" => "tag is missing, blank, or has an invalid type",
        "changed_content" => "an already imported legacy row has different authored content",
        _ => "legacy row is invalid",
    }
}

fn legacy_row_identity(provider: &str, legacy_id: i64, url: &str) -> String {
    let mut digest = Sha256::new();
    digest.update(b"researchpocket-v1\0");
    let legacy_id = legacy_id.to_be_bytes();
    for part in [provider.as_bytes(), legacy_id.as_slice(), url.as_bytes()] {
        digest.update((part.len() as u64).to_be_bytes());
        digest.update(part);
    }
    hex_digest(digest.finalize().as_slice())
}

struct NewMapping {
    row_identity: String,
    content_sha256: String,
    item_id: String,
    provider: String,
    legacy_id: i64,
}

impl V2Store {
    pub async fn import_v1(&self, source: impl AsRef<Path>) -> StoreResult<ImportResult> {
        let source = fs::canonicalize(source.as_ref())?;
        if source == fs::canonicalize(self.database_path())? {
            return Err(StoreError::InvalidV1Schema(
                "the V1 source cannot be the active V2 library".into(),
            ));
        }
        let staged = stage_source(&source)?;
        let prepared = read_source(&staged.database).await?;
        staged.verify_unchanged()?;

        let mut connection = self.pool.acquire().await?;
        sqlx::query("BEGIN IMMEDIATE")
            .execute(&mut *connection)
            .await?;
        let result = commit_import(&mut connection, &staged.receipt, prepared).await;
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

async fn commit_import(
    connection: &mut SqliteConnection,
    receipt: &SourceBundleReceipt,
    prepared: PreparedImport,
) -> StoreResult<ImportResult> {
    let now = now_rfc3339();
    let receipt_json = serde_json::to_string(receipt)?;
    sqlx::query(
        "INSERT INTO import_sources \
         (source_kind, source_digest, bundle_receipt_json, first_seen_at, last_seen_at) \
         VALUES (?, ?, ?, ?, ?) \
         ON CONFLICT(source_digest) DO UPDATE SET \
         bundle_receipt_json = excluded.bundle_receipt_json, last_seen_at = excluded.last_seen_at",
    )
    .bind(SOURCE_KIND)
    .bind(&receipt.sha256)
    .bind(receipt_json)
    .bind(&now)
    .bind(&now)
    .execute(&mut *connection)
    .await?;
    let source_id: i64 =
        sqlx::query_scalar("SELECT source_id FROM import_sources WHERE source_digest = ?")
            .bind(&receipt.sha256)
            .fetch_one(&mut *connection)
            .await?;

    let library_id = metadata(connection, "library_id").await?;
    let device_id = metadata(connection, "device_id").await?;
    let sequence_text: String =
        sqlx::query_scalar("SELECT next_sequence FROM devices WHERE device_id = ?")
            .bind(&device_id)
            .fetch_one(&mut *connection)
            .await?;
    let sequence = sequence_text
        .parse::<u64>()
        .map_err(|_| StoreError::InvalidStore("invalid device sequence".into()))?;
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
    let before = library.version();

    let mut imported = 0_u64;
    let mut skipped = 0_u64;
    let mut imported_tags = BTreeSet::new();
    let mut rejections = prepared.rejections;
    let mut mappings = Vec::new();
    let mut source_rows = Vec::new();
    for (index, row) in prepared.rows.into_iter().enumerate() {
        let existing = sqlx::query(
            "SELECT item_id, content_sha256 FROM import_rows WHERE row_identity = ?",
        )
        .bind(&row.row_identity)
        .fetch_optional(&mut *connection)
        .await?;
        if let Some(existing) = existing {
            let item_id: String = existing.try_get("item_id")?;
            let existing_content: String = existing.try_get("content_sha256")?;
            if existing_content != row.content_sha256 {
                reject(
                    &mut rejections,
                    Some(row.legacy_id),
                    "items",
                    "changed_content",
                );
            }
            skipped = skipped
                .checked_add(1)
                .ok_or(StoreError::NumericRange("skipped count"))?;
            source_rows.push((row.row_identity, item_id, "already_imported"));
            continue;
        }

        let item_id = Uuid::now_v7().to_string();
        let operation_prefix = format!("{device_id}/{sequence_text}/item/{index:020}");
        library.create_item(
            &ItemSeed {
                item_id: item_id.clone(),
                url: row.url,
                title: row.title,
                excerpt: row.excerpt,
                favorite: row.favorite,
                language: row.language,
                saved_at: row.saved_at,
                note: row.note,
                tags: row.tags.clone(),
            },
            &operation_prefix,
        )?;
        imported = imported
            .checked_add(1)
            .ok_or(StoreError::NumericRange("imported count"))?;
        imported_tags.extend(row.tags.iter().cloned());
        source_rows.push((row.row_identity.clone(), item_id.clone(), "imported"));
        mappings.push(NewMapping {
            row_identity: row.row_identity,
            content_sha256: row.content_sha256,
            item_id,
            provider: row.provider,
            legacy_id: row.legacy_id,
        });
    }

    if imported > 0 {
        let envelope =
            library.export_envelope(&before, &library_id, &device_id, sequence, &now)?;
        let new_snapshot = library.export_snapshot()?;
        let projection = library.canonical_projection()?;
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

        let envelope_json = serde_json::to_string(&envelope)?;
        let path = envelope.path();
        sqlx::query(
            "INSERT INTO batches \
             (device_id, sequence, payload_sha256, protocol_version, library_id, path, \
              envelope_json, origin, applied_at) \
             VALUES (?, ?, ?, ?, ?, ?, ?, 'local', ?)",
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
        sqlx::query("INSERT INTO outbox (device_id, sequence, enqueued_at) VALUES (?, ?, ?)")
            .bind(&envelope.device_id)
            .bind(&envelope.sequence)
            .bind(&now)
            .execute(&mut *connection)
            .await?;
        let next = sequence
            .checked_add(1)
            .ok_or(StoreError::NumericRange("device sequence"))?;
        sqlx::query("UPDATE devices SET next_sequence = ? WHERE device_id = ?")
            .bind(format!("{next:020}"))
            .bind(&device_id)
            .execute(&mut *connection)
            .await?;
    }

    for mapping in mappings {
        sqlx::query(
            "INSERT INTO import_rows \
             (row_identity, content_sha256, item_id, provider, legacy_id, first_source_id, imported_at) \
             VALUES (?, ?, ?, ?, ?, ?, ?)",
        )
        .bind(&mapping.row_identity)
        .bind(&mapping.content_sha256)
        .bind(&mapping.item_id)
        .bind(&mapping.provider)
        .bind(mapping.legacy_id)
        .bind(source_id)
        .bind(&now)
        .execute(&mut *connection)
        .await?;
    }
    for (row_identity, item_id, disposition) in source_rows {
        sqlx::query(
            "INSERT INTO import_source_rows (source_id, row_identity, item_id, disposition) \
             VALUES (?, ?, ?, ?) \
             ON CONFLICT(source_id, row_identity) DO UPDATE SET \
             item_id = excluded.item_id, disposition = excluded.disposition",
        )
        .bind(source_id)
        .bind(row_identity)
        .bind(item_id)
        .bind(disposition)
        .execute(&mut *connection)
        .await?;
    }
    for rejection in &rejections {
        sqlx::query(
            "INSERT INTO import_rejections (source_id, legacy_id, field, code, reason) \
             VALUES (?, ?, ?, ?, ?) \
             ON CONFLICT(source_id, legacy_id, field, code) DO UPDATE SET reason = excluded.reason",
        )
        .bind(source_id)
        .bind(rejection.legacy_id)
        .bind(&rejection.field)
        .bind(&rejection.code)
        .bind(&rejection.reason)
        .execute(&mut *connection)
        .await?;
    }

    Ok(ImportResult {
        source_sha256: receipt
            .files
            .iter()
            .find(|file| file.role == "main")
            .map(|file| file.sha256.clone())
            .ok_or_else(|| {
                StoreError::InvalidV1Schema("source receipt has no main file".into())
            })?,
        source_bundle_sha256: receipt.sha256.clone(),
        source_unchanged: true,
        scanned: prepared.scanned,
        imported,
        skipped,
        rejection_count: u64::try_from(rejections.len())
            .map_err(|_| StoreError::NumericRange("rejection count"))?,
        tags_imported: u64::try_from(imported_tags.len())
            .map_err(|_| StoreError::NumericRange("tag count"))?,
        rejections,
    })
}

fn is_supported_url(value: &str) -> bool {
    validate_item_url(value).is_ok()
}

async fn metadata(connection: &mut SqliteConnection, key: &str) -> StoreResult<String> {
    sqlx::query_scalar("SELECT value FROM store_meta WHERE key = ?")
        .bind(key)
        .fetch_optional(&mut *connection)
        .await?
        .ok_or_else(|| StoreError::InvalidStore(format!("missing metadata key {key}")))
}

pub(crate) async fn persist_projection(
    connection: &mut SqliteConnection,
    projection: &CanonicalProjection,
) -> StoreResult<()> {
    for (item_id, item) in &projection.items {
        persist_item_projection(connection, item_id, item).await?;
    }
    Ok(())
}

pub(crate) async fn persist_item_projection(
    connection: &mut SqliteConnection,
    item_id: &str,
    item: &CanonicalItem,
) -> StoreResult<()> {
    let lifecycle_state = match item.lifecycle.state {
        LifecycleState::Active => "active",
        LifecycleState::Deleted => "deleted",
    };
    let lifecycle_generation = i64::try_from(item.lifecycle.generation)
        .map_err(|_| StoreError::NumericRange("lifecycle generation"))?;
    sqlx::query(
        "INSERT INTO items \
         (item_id, url, title, excerpt, favorite, language, saved_at, note, \
          lifecycle_state, lifecycle_generation) \
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?) \
         ON CONFLICT(item_id) DO UPDATE SET \
         url = excluded.url, title = excluded.title, excerpt = excluded.excerpt, \
         favorite = excluded.favorite, language = excluded.language, \
         saved_at = excluded.saved_at, note = excluded.note, \
         lifecycle_state = excluded.lifecycle_state, \
         lifecycle_generation = excluded.lifecycle_generation",
    )
    .bind(item_id)
    .bind(&item.url.value)
    .bind(&item.title.value)
    .bind(&item.excerpt.value)
    .bind(item.favorite.value)
    .bind(&item.language.value)
    .bind(item.saved_at.value)
    .bind(&item.note)
    .bind(lifecycle_state)
    .bind(lifecycle_generation)
    .execute(&mut *connection)
    .await?;
    sqlx::query("DELETE FROM item_tags WHERE item_id = ?")
        .bind(item_id)
        .execute(&mut *connection)
        .await?;
    for tag in &item.tags {
        sqlx::query("INSERT INTO item_tags (item_id, tag) VALUES (?, ?)")
            .bind(item_id)
            .bind(tag)
            .execute(&mut *connection)
            .await?;
    }
    sqlx::query("DELETE FROM item_search WHERE item_id = ?")
        .bind(item_id)
        .execute(&mut *connection)
        .await?;
    sqlx::query(
        "INSERT INTO item_search (item_id, url, title, excerpt, note, tags) \
         VALUES (?, ?, ?, ?, ?, ?)",
    )
    .bind(item_id)
    .bind(&item.url.value)
    .bind(item.title.value.as_deref().unwrap_or(""))
    .bind(item.excerpt.value.as_deref().unwrap_or(""))
    .bind(&item.note)
    .bind(item.tags.join(" "))
    .execute(&mut *connection)
    .await?;
    Ok(())
}
