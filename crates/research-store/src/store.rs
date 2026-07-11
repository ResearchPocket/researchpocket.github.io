use std::fs::{self, OpenOptions};
use std::io::{Read, Seek, SeekFrom};
use std::path::{Path, PathBuf};
use std::time::Duration;

use chrono::{DateTime, SecondsFormat, Utc};
use research_domain::Library;
use sha2::{Digest, Sha256};
use sqlx::sqlite::{
    SqliteConnectOptions, SqliteJournalMode, SqlitePoolOptions, SqliteSynchronous,
};
use sqlx::{Connection, FromRow, Pool, QueryBuilder, Row, Sqlite, SqliteConnection};
use uuid::Uuid;

use crate::{
    ListPage, ListQuery, ListResult, SearchQuery, SearchResult, StoreError, StoreResult,
    StoreStatus, StoredItem,
};

const DATABASE_FILE: &str = "library.sqlite3";
const FIRST_SEQUENCE: &str = "00000000000000000001";
const STORE_SCHEMA_VERSION: &str = "1";
const SYNC_PROTOCOL_VERSION: &str = "1";
const SQLITE_APPLICATION_ID: u32 = 0x5250_5632; // "RPV2"
const SET_SQLITE_APPLICATION_ID: &str = "PRAGMA application_id = 1380996658";

static MIGRATOR: sqlx::migrate::Migrator = sqlx::migrate!("./migrations");

pub struct V2Store {
    pub(crate) pool: Pool<Sqlite>,
    database_path: PathBuf,
}

impl V2Store {
    /// Initialize a new local V2 library, or reopen an existing valid one.
    pub async fn init(data_dir: impl AsRef<Path>) -> StoreResult<Self> {
        let data_dir = data_dir.as_ref();
        let database_path = data_dir.join(DATABASE_FILE);
        if database_path.is_file() {
            return Self::open(data_dir).await;
        }
        if data_dir.exists() && fs::read_dir(data_dir)?.next().is_some() {
            return Err(StoreError::NonEmptyDataDirectory(data_dir.to_path_buf()));
        }

        fs::create_dir_all(data_dir)?;
        make_private_directory(data_dir)?;
        create_private_database_file(&database_path)?;
        initialize_database_identity(&database_path).await?;
        let pool = connect(&database_path, false).await?;
        MIGRATOR.run(&pool).await?;

        let library_id = Uuid::now_v7().to_string();
        let device_id = Uuid::now_v7().to_string();
        let library = Library::new();
        let snapshot = library.export_snapshot()?;
        let snapshot_sha256 = sha256_hex(&snapshot);
        let now = now_rfc3339();

        let mut transaction = pool.begin().await?;
        for (key, value) in [
            ("store_schema_version", STORE_SCHEMA_VERSION),
            ("sync_protocol_version", SYNC_PROTOCOL_VERSION),
            ("library_id", library_id.as_str()),
            ("device_id", device_id.as_str()),
        ] {
            sqlx::query("INSERT INTO store_meta (key, value) VALUES (?, ?)")
                .bind(key)
                .bind(value)
                .execute(&mut *transaction)
                .await?;
        }
        sqlx::query("INSERT INTO devices (device_id, next_sequence) VALUES (?, ?)")
            .bind(&device_id)
            .bind(FIRST_SEQUENCE)
            .execute(&mut *transaction)
            .await?;
        sqlx::query(
            "INSERT INTO canonical_state \
             (singleton, snapshot, snapshot_sha256, updated_at) VALUES (1, ?, ?, ?)",
        )
        .bind(snapshot)
        .bind(snapshot_sha256)
        .bind(now)
        .execute(&mut *transaction)
        .await?;
        transaction.commit().await?;

        Ok(Self {
            pool,
            database_path,
        })
    }

    /// Open an initialized local V2 library and validate its canonical snapshot.
    pub async fn open(data_dir: impl AsRef<Path>) -> StoreResult<Self> {
        let database_path = data_dir.as_ref().join(DATABASE_FILE);
        if !database_path.is_file() {
            return Err(StoreError::NotInitialized(database_path));
        }
        recognize_database(&database_path)?;
        let pool = connect(&database_path, false).await?;
        MIGRATOR.run(&pool).await?;
        let store = Self {
            pool,
            database_path,
        };
        store.validate().await?;
        Ok(store)
    }

    pub fn database_path(&self) -> &Path {
        &self.database_path
    }

    pub async fn list(&self, query: ListQuery) -> StoreResult<ListResult> {
        let total = self.count_items(&query).await?;
        let offset =
            i64::try_from(query.offset).map_err(|_| StoreError::NumericRange("offset"))?;
        let limit = match query.limit {
            Some(value) => {
                i64::try_from(value).map_err(|_| StoreError::NumericRange("limit"))?
            }
            None => -1,
        };

        let mut builder = QueryBuilder::<Sqlite>::new(
            "SELECT i.item_id, i.url, i.title, i.excerpt, i.favorite, i.language, \
             i.saved_at, i.note, i.lifecycle_state FROM items i WHERE 1 = 1",
        );
        append_list_filters(&mut builder, &query);
        builder
            .push(" ORDER BY i.saved_at DESC, i.item_id ASC LIMIT ")
            .push_bind(limit)
            .push(" OFFSET ")
            .push_bind(offset);
        let rows = builder
            .build_query_as::<ItemRow>()
            .fetch_all(&self.pool)
            .await?;

        let items = self.materialize_rows(rows).await?;

        Ok(ListResult {
            page: ListPage {
                total,
                offset: query.offset,
                returned: items.len(),
            },
            items,
        })
    }

    pub async fn search(&self, query: SearchQuery) -> StoreResult<SearchResult> {
        let text = query.text.trim();
        if text.is_empty() {
            return Err(StoreError::InvalidInput(
                "search query cannot be blank".into(),
            ));
        }
        let offset =
            i64::try_from(query.offset).map_err(|_| StoreError::NumericRange("offset"))?;
        let limit = match query.limit {
            Some(value) => {
                i64::try_from(value).map_err(|_| StoreError::NumericRange("limit"))?
            }
            None => -1,
        };

        let mut count_builder = QueryBuilder::<Sqlite>::new(
            "SELECT COUNT(*) FROM item_search JOIN items i \
             ON i.item_id = item_search.item_id WHERE item_search MATCH ",
        );
        count_builder.push_bind(text.to_owned());
        append_item_filters(
            &mut count_builder,
            &query.tags,
            query.favorite_only,
            query.include_deleted,
        );
        let total: i64 = count_builder
            .build_query_scalar()
            .fetch_one(&self.pool)
            .await
            .map_err(search_error)?;
        let total = u64::try_from(total)
            .map_err(|_| StoreError::NumericRange("search result count"))?;

        let mut builder = QueryBuilder::<Sqlite>::new(
            "SELECT i.item_id, i.url, i.title, i.excerpt, i.favorite, i.language, \
             i.saved_at, i.note, i.lifecycle_state \
             FROM item_search JOIN items i ON i.item_id = item_search.item_id \
             WHERE item_search MATCH ",
        );
        builder.push_bind(text.to_owned());
        append_item_filters(
            &mut builder,
            &query.tags,
            query.favorite_only,
            query.include_deleted,
        );
        builder
            .push(" ORDER BY bm25(item_search), i.saved_at DESC, i.item_id ASC LIMIT ")
            .push_bind(limit)
            .push(" OFFSET ")
            .push_bind(offset);
        let rows = builder
            .build_query_as::<ItemRow>()
            .fetch_all(&self.pool)
            .await
            .map_err(search_error)?;
        let items = self.materialize_rows(rows).await?;

        Ok(SearchResult {
            query: text.to_owned(),
            page: ListPage {
                total,
                offset: query.offset,
                returned: items.len(),
            },
            items,
        })
    }

    pub async fn status(&self) -> StoreResult<StoreStatus> {
        let library_id = self.meta("library_id").await?;
        let device_id = self.meta("device_id").await?;
        let next_sequence: String =
            sqlx::query_scalar("SELECT next_sequence FROM devices WHERE device_id = ?")
                .bind(&device_id)
                .fetch_one(&self.pool)
                .await?;
        let next_sequence = next_sequence
            .parse::<u64>()
            .map_err(|_| StoreError::InvalidStore("invalid device sequence".into()))?;
        let active_items = count_scalar(
            &self.pool,
            "SELECT COUNT(*) FROM items WHERE lifecycle_state = 'active'",
        )
        .await?;
        let deleted_items = count_scalar(
            &self.pool,
            "SELECT COUNT(*) FROM items WHERE lifecycle_state = 'deleted'",
        )
        .await?;
        let pending_updates = count_scalar(&self.pool, "SELECT COUNT(*) FROM outbox").await?;
        let imported_items =
            count_scalar(&self.pool, "SELECT COUNT(*) FROM import_rows").await?;
        let import_sources =
            count_scalar(&self.pool, "SELECT COUNT(*) FROM import_sources").await?;

        Ok(StoreStatus {
            library_id,
            device_id,
            active_items,
            deleted_items,
            pending_updates,
            imported_items,
            import_sources,
            next_sequence,
            sync_state: "not_configured".to_owned(),
        })
    }

    pub(crate) async fn meta(&self, key: &str) -> StoreResult<String> {
        sqlx::query_scalar("SELECT value FROM store_meta WHERE key = ?")
            .bind(key)
            .fetch_optional(&self.pool)
            .await?
            .ok_or_else(|| StoreError::InvalidStore(format!("missing metadata key {key}")))
    }

    async fn validate(&self) -> StoreResult<()> {
        if self.meta("store_schema_version").await? != STORE_SCHEMA_VERSION {
            return Err(StoreError::InvalidStore(
                "unsupported store schema version".into(),
            ));
        }
        if self.meta("sync_protocol_version").await? != SYNC_PROTOCOL_VERSION {
            return Err(StoreError::InvalidStore(
                "unsupported sync protocol version".into(),
            ));
        }
        let row = sqlx::query(
            "SELECT snapshot, snapshot_sha256 FROM canonical_state WHERE singleton = 1",
        )
        .fetch_optional(&self.pool)
        .await?
        .ok_or_else(|| StoreError::InvalidStore("canonical snapshot is missing".into()))?;
        let snapshot: Vec<u8> = row.try_get("snapshot")?;
        let expected: String = row.try_get("snapshot_sha256")?;
        if sha256_hex(&snapshot) != expected {
            return Err(StoreError::InvalidStore(
                "canonical snapshot checksum mismatch".into(),
            ));
        }
        Library::from_snapshot(&snapshot, fresh_peer_id())?;
        Ok(())
    }

    async fn count_items(&self, query: &ListQuery) -> StoreResult<u64> {
        let mut builder =
            QueryBuilder::<Sqlite>::new("SELECT COUNT(*) FROM items i WHERE 1 = 1");
        append_list_filters(&mut builder, query);
        let count: i64 = builder.build_query_scalar().fetch_one(&self.pool).await?;
        u64::try_from(count).map_err(|_| StoreError::NumericRange("item count"))
    }

    async fn materialize_rows(&self, rows: Vec<ItemRow>) -> StoreResult<Vec<StoredItem>> {
        let mut items = Vec::with_capacity(rows.len());
        for row in rows {
            let tags = sqlx::query_scalar::<_, String>(
                "SELECT tag FROM item_tags WHERE item_id = ? ORDER BY tag ASC",
            )
            .bind(&row.item_id)
            .fetch_all(&self.pool)
            .await?;
            let saved_at = DateTime::<Utc>::from_timestamp(row.saved_at, 0)
                .ok_or_else(|| {
                    StoreError::InvalidStore("an item has an invalid timestamp".into())
                })?
                .to_rfc3339_opts(SecondsFormat::Secs, true);
            items.push(StoredItem {
                id: row.item_id,
                url: row.url,
                title: row.title,
                excerpt: row.excerpt,
                note: (!row.note.is_empty()).then_some(row.note),
                favorite: row.favorite,
                language: row.language,
                saved_at,
                tags,
                state: row.lifecycle_state,
            });
        }
        Ok(items)
    }
}

#[derive(FromRow)]
struct ItemRow {
    item_id: String,
    url: String,
    title: Option<String>,
    excerpt: Option<String>,
    favorite: bool,
    language: Option<String>,
    saved_at: i64,
    note: String,
    lifecycle_state: String,
}

fn append_list_filters(builder: &mut QueryBuilder<Sqlite>, query: &ListQuery) {
    append_item_filters(
        builder,
        &query.tags,
        query.favorite_only,
        query.include_deleted,
    );
}

fn append_item_filters(
    builder: &mut QueryBuilder<Sqlite>,
    tags: &[String],
    favorite_only: bool,
    include_deleted: bool,
) {
    if !include_deleted {
        builder.push(" AND i.lifecycle_state = 'active'");
    }
    if favorite_only {
        builder.push(" AND i.favorite = 1");
    }
    for tag in tags {
        builder
            .push(" AND EXISTS (SELECT 1 FROM item_tags it WHERE it.item_id = i.item_id AND it.tag = ")
            .push_bind(tag.clone())
            .push(")");
    }
}

fn search_error(error: sqlx::Error) -> StoreError {
    if let sqlx::Error::Database(database) = &error {
        let message = database.message().to_ascii_lowercase();
        if message.contains("fts5:")
            || message.contains("malformed match")
            || message.contains("unterminated string")
            || message.contains("syntax error")
        {
            return StoreError::InvalidInput("invalid full-text search query".into());
        }
    }
    StoreError::Sqlite(error)
}

async fn connect(database_path: &Path, create: bool) -> StoreResult<Pool<Sqlite>> {
    let options = SqliteConnectOptions::new()
        .filename(database_path)
        .create_if_missing(create)
        .foreign_keys(true)
        .journal_mode(SqliteJournalMode::Wal)
        .synchronous(SqliteSynchronous::Full)
        .busy_timeout(Duration::from_secs(5));
    Ok(SqlitePoolOptions::new()
        .max_connections(4)
        .connect_with(options)
        .await?)
}

async fn initialize_database_identity(database_path: &Path) -> StoreResult<()> {
    // Set the recognition marker before enabling WAL. That guarantees it lives
    // in the main SQLite header and remains readable after a crash, even when a
    // later WAL has not been checkpointed yet.
    let options = SqliteConnectOptions::new()
        .filename(database_path)
        .create_if_missing(false);
    let mut connection = SqliteConnection::connect_with(&options).await?;
    sqlx::query(SET_SQLITE_APPLICATION_ID)
        .execute(&mut connection)
        .await?;
    connection.close().await?;
    recognize_database(database_path)
}

async fn count_scalar(pool: &Pool<Sqlite>, sql: &'static str) -> StoreResult<u64> {
    let count: i64 = sqlx::query_scalar(sql).fetch_one(pool).await?;
    u64::try_from(count).map_err(|_| StoreError::NumericRange("count"))
}

pub(crate) fn now_rfc3339() -> String {
    Utc::now().to_rfc3339_opts(SecondsFormat::Millis, true)
}

pub(crate) fn fresh_peer_id() -> u64 {
    let uuid = Uuid::now_v7();
    let mut bytes = [0_u8; 8];
    bytes.copy_from_slice(&uuid.as_bytes()[8..]);
    u64::from_be_bytes(bytes).max(1)
}

pub(crate) fn sha256_hex(bytes: &[u8]) -> String {
    Sha256::digest(bytes)
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect()
}

fn make_private_directory(path: &Path) -> StoreResult<()> {
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        fs::set_permissions(path, fs::Permissions::from_mode(0o700))?;
    }
    Ok(())
}

fn create_private_database_file(path: &Path) -> StoreResult<()> {
    let mut options = OpenOptions::new();
    options.write(true).create_new(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    options.open(path)?;
    make_private_file(path)
}

fn make_private_file(path: &Path) -> StoreResult<()> {
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        fs::set_permissions(path, fs::Permissions::from_mode(0o600))?;
    }
    Ok(())
}

fn recognize_database(path: &Path) -> StoreResult<()> {
    let mut file = fs::File::open(path)?;
    let mut header = [0_u8; 72];
    file.read_exact(&mut header)
        .map_err(|_| StoreError::InvalidStore("database has no valid SQLite header".into()))?;
    if &header[..16] != b"SQLite format 3\0" {
        return Err(StoreError::InvalidStore(
            "database has no valid SQLite header".into(),
        ));
    }
    file.seek(SeekFrom::Start(68))?;
    let mut application_id = [0_u8; 4];
    file.read_exact(&mut application_id)?;
    if u32::from_be_bytes(application_id) != SQLITE_APPLICATION_ID {
        return Err(StoreError::InvalidStore(
            "database is not a ResearchPocket V2 library".into(),
        ));
    }
    Ok(())
}
