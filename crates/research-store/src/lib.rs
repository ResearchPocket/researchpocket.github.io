//! Durable, local-only persistence for a V2 ResearchPocket library.

mod error;
mod import;
mod model;
mod store;

pub use error::{StoreError, StoreResult};
pub use model::{
    ImportRejection, ImportResult, ListPage, ListQuery, ListResult, SourceBundleReceipt,
    SourceFileReceipt, StoreStatus, StoredItem,
};
pub use store::V2Store;
