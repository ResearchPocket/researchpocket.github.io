use serde::{Deserialize, Serialize};

#[derive(Clone, Debug, Default)]
pub struct ListQuery {
    pub tags: Vec<String>,
    pub favorite_only: bool,
    pub include_deleted: bool,
    pub limit: Option<usize>,
    pub offset: usize,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
pub struct StoredItem {
    pub id: String,
    pub url: String,
    pub title: Option<String>,
    pub excerpt: Option<String>,
    pub note: Option<String>,
    pub favorite: bool,
    pub language: Option<String>,
    pub saved_at: String,
    pub tags: Vec<String>,
    pub state: String,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
pub struct ListPage {
    pub total: u64,
    pub offset: usize,
    pub returned: usize,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
pub struct ListResult {
    pub page: ListPage,
    pub items: Vec<StoredItem>,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
pub struct StoreStatus {
    pub library_id: String,
    pub device_id: String,
    pub active_items: u64,
    pub deleted_items: u64,
    pub pending_updates: u64,
    pub imported_items: u64,
    pub import_sources: u64,
    pub next_sequence: u64,
    pub sync_state: String,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
pub struct ImportRejection {
    pub legacy_id: Option<i64>,
    pub field: String,
    pub code: String,
    pub reason: String,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
pub struct SourceFileReceipt {
    pub role: String,
    pub bytes: u64,
    pub sha256: String,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
pub struct SourceBundleReceipt {
    pub sha256: String,
    pub files: Vec<SourceFileReceipt>,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
pub struct ImportResult {
    pub source_sha256: String,
    pub source_bundle_sha256: String,
    pub source_unchanged: bool,
    pub scanned: u64,
    pub imported: u64,
    pub skipped: u64,
    pub rejection_count: u64,
    pub tags_imported: u64,
    pub rejections: Vec<ImportRejection>,
}
