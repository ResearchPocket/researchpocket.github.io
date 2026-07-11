//! Durable, local-only persistence for a V2 ResearchPocket library.

mod error;
mod import;
mod model;
mod mutation;
mod store;

pub use error::{StoreError, StoreResult};
pub use model::{
    CreateItemRequest, EditItemRequest, ImportRejection, ImportResult, ListPage, ListQuery,
    ListResult, OptionalTextUpdate, SourceBundleReceipt, SourceFileReceipt, StoreStatus,
    StoredItem,
};
pub use store::V2Store;
