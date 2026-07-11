use thiserror::Error;

pub type StoreResult<T> = Result<T, StoreError>;

#[derive(Debug, Error)]
pub enum StoreError {
    #[error("domain operation failed: {0}")]
    Domain(#[from] research_domain::DomainError),
    #[error("filesystem operation failed: {0}")]
    Io(#[from] std::io::Error),
    #[error("JSON operation failed: {0}")]
    Json(#[from] serde_json::Error),
    #[error("SQLite operation failed: {0}")]
    Sqlite(#[from] sqlx::Error),
    #[error("SQLite migration failed: {0}")]
    Migration(#[from] sqlx::migrate::MigrateError),
    #[error("V2 library is not initialized at {0}")]
    NotInitialized(std::path::PathBuf),
    #[error("refusing to initialize over non-library data in {0}")]
    NonEmptyDataDirectory(std::path::PathBuf),
    #[error("invalid V2 store: {0}")]
    InvalidStore(String),
    #[error("unsupported or malformed V1 schema: {0}")]
    InvalidV1Schema(String),
    #[error("the V1 source changed while its private snapshot was being created")]
    SourceChanged,
    #[error("a numeric value cannot be represented safely: {0}")]
    NumericRange(&'static str),
    #[error("item {0} was not found")]
    ItemNotFound(String),
    #[error("the edit does not contain any changes")]
    NoChanges,
    #[error("invalid mutation input: {0}")]
    InvalidInput(String),
    #[error("synchronization is not configured")]
    SyncNotConfigured,
    #[error("cannot adopt remote library {0}: the local library is not pristine")]
    SyncLibraryMismatch(String),
    #[error("synchronization integrity failure: {0}")]
    SyncIntegrity(String),
}
