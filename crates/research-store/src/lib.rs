//! Durable, local-only persistence for a V2 ResearchPocket library.

mod enrichment;
mod error;
mod import;
mod model;
mod mutation;
mod store;
mod sync;

pub use enrichment::ENRICHMENT_MAX_ATTEMPTS;
pub use error::{StoreError, StoreResult};
pub use model::{
    CreateItemRequest, EditItemRequest, EnrichmentApplyResult, EnrichmentCandidates,
    EnrichmentClaim, EnrichmentJob, EnrichmentProvider, EnrichmentQueueCounts,
    EnrichmentStatus, ImportRejection, ImportResult, ListPage, ListQuery, ListResult,
    OptionalTextUpdate, PendingBatch, RemoteBatchDisposition, RemoteBatchResult, SearchQuery,
    SearchResult, SourceBundleReceipt, SourceFileReceipt, StoreStatus, StoredItem,
    SyncConfiguration, SyncIdentity,
};
pub use store::V2Store;
