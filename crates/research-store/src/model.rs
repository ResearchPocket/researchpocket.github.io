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
pub struct CreateItemRequest {
    pub url: String,
    pub title: Option<String>,
    pub excerpt: Option<String>,
    pub favorite: bool,
    pub language: Option<String>,
    /// Unix seconds. `None` captures the current time.
    pub saved_at: Option<i64>,
    pub note: String,
    pub tags: Vec<String>,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum OptionalTextUpdate {
    Set(String),
    Clear,
}

#[derive(Clone, Debug, Default, Eq, PartialEq, Serialize, Deserialize)]
pub struct EditItemRequest {
    pub item_id: String,
    pub url: Option<String>,
    pub title: Option<OptionalTextUpdate>,
    pub excerpt: Option<OptionalTextUpdate>,
    pub favorite: Option<bool>,
    pub language: Option<OptionalTextUpdate>,
    pub saved_at: Option<i64>,
    pub note: Option<String>,
    /// Reject a note replacement unless the current note still has this value.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub expected_note: Option<String>,
    pub add_tags: Vec<String>,
    pub remove_tags: Vec<String>,
}

impl EditItemRequest {
    pub fn has_changes(&self) -> bool {
        self.url.is_some()
            || self.title.is_some()
            || self.excerpt.is_some()
            || self.favorite.is_some()
            || self.language.is_some()
            || self.saved_at.is_some()
            || self.note.is_some()
            || !self.add_tags.is_empty()
            || !self.remove_tags.is_empty()
    }
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

#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum EnrichmentProvider {
    Direct,
    Firecrawl,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum EnrichmentStatus {
    Pending,
    Retry,
    InProgress,
    Succeeded,
    Failed,
    Skipped,
}

#[derive(Clone, Debug, Default, Eq, PartialEq, Serialize, Deserialize)]
pub struct EnrichmentCandidates {
    pub title: Option<String>,
    pub excerpt: Option<String>,
    pub language: Option<String>,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
pub struct EnrichmentJob {
    pub item_id: String,
    pub provider: EnrichmentProvider,
    pub status: EnrichmentStatus,
    pub attempts: u64,
    pub target_title: bool,
    pub target_excerpt: bool,
    pub target_language: bool,
    pub queued_at: String,
    pub updated_at: String,
    pub next_attempt_at: Option<String>,
    pub last_attempt_at: Option<String>,
    pub completed_at: Option<String>,
    pub last_error_kind: Option<String>,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct EnrichmentClaim {
    pub job: EnrichmentJob,
    pub lease_token: String,
}

#[derive(Clone, Debug, Default, Eq, PartialEq, Serialize, Deserialize)]
pub struct EnrichmentQueueCounts {
    pub pending: u64,
    pub retrying: u64,
    pub in_progress: u64,
    pub succeeded: u64,
    pub failed: u64,
    pub skipped: u64,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
pub struct EnrichmentApplyResult {
    pub item: StoredItem,
    pub job: EnrichmentJob,
    pub applied_title: bool,
    pub applied_excerpt: bool,
    pub applied_language: bool,
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

#[derive(Clone, Debug, Default)]
pub struct SearchQuery {
    pub text: String,
    pub tags: Vec<String>,
    pub favorite_only: bool,
    pub include_deleted: bool,
    pub limit: Option<usize>,
    pub offset: usize,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
pub struct SearchResult {
    pub query: String,
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
    pub deferred_updates: u64,
    pub imported_items: u64,
    pub import_sources: u64,
    pub next_sequence: u64,
    pub sync_state: String,
    pub sync_remote: Option<SyncConfiguration>,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
pub struct SyncConfiguration {
    pub owner: String,
    pub repository: String,
    pub branch: String,
    pub configured_at: String,
    pub last_success_at: Option<String>,
    pub last_error_kind: Option<String>,
    pub last_error_at: Option<String>,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct SyncIdentity {
    pub library_id: String,
    pub device_id: String,
    pub pristine: bool,
}

#[derive(Clone, Debug)]
pub struct PendingBatch {
    pub device_id: String,
    pub sequence: String,
    pub path: String,
    pub payload_sha256: String,
    pub envelope_json: String,
    pub attempts: u64,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum RemoteBatchDisposition {
    Applied,
    AlreadyApplied,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct RemoteBatchResult {
    pub disposition: RemoteBatchDisposition,
    pub acknowledged_outbox: bool,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct RemotePackResult {
    pub member_count: u64,
    pub applied: u64,
    pub already_applied: u64,
    pub acknowledged_outbox: u64,
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
