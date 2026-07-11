//! Durable, local-only persistence for a V2 ResearchPocket library.

mod error;
mod import;
mod model;
mod mutation;
mod store;
mod sync;

pub use error::{StoreError, StoreResult};
pub use model::{
    CreateItemRequest, EditItemRequest, ImportRejection, ImportResult, ListPage, ListQuery,
    ListResult, OptionalTextUpdate, PendingBatch, RemoteBatchDisposition, RemoteBatchResult,
    SearchQuery, SearchResult, SourceBundleReceipt, SourceFileReceipt, StoreStatus, StoredItem,
    SyncConfiguration, SyncIdentity,
};
pub use store::V2Store;
