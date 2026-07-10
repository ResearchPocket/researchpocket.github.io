use std::collections::{BTreeMap, BTreeSet};

use loro::{
    Container, ExportMode, LoroDoc, LoroMap, LoroText, ToJson, ValueOrContainer, VersionVector,
};
use serde::de::DeserializeOwned;
use thiserror::Error;

use crate::ScalarRevision;
use crate::{
    CanonicalItem, CanonicalProjection, LifecycleRevision, LifecycleState, UpdateEnvelope,
    projection::{causal_heads, lifecycle_view, scalar_view},
};

const ITEMS: &str = "items";
const NOTE: &str = "note";
const SCALARS: &str = "scalars";
const REVISIONS: &str = "revisions";
const TAGS: &str = "tags";
const ADDS: &str = "adds";
const REMOVES: &str = "removes";
const LIFECYCLE: &str = "lifecycle";

pub type DomainResult<T> = Result<T, DomainError>;

#[derive(Debug, Error)]
pub enum DomainError {
    #[error("Loro operation failed: {0}")]
    Loro(String),
    #[error("JSON operation failed: {0}")]
    Json(#[from] serde_json::Error),
    #[error("base64 decoding failed: {0}")]
    Base64(#[from] base64::DecodeError),
    #[error("unsupported protocol version {0}")]
    UnsupportedProtocol(u8),
    #[error("integrity failure at {path}: expected {expected}, got {actual}")]
    Integrity {
        path: String,
        expected: String,
        actual: String,
    },
    #[error("invalid CRDT state: {0}")]
    InvalidState(String),
}

pub struct Library {
    doc: LoroDoc,
}

impl Library {
    pub fn new() -> Self {
        Self {
            doc: LoroDoc::new(),
        }
    }

    /// Deterministic peer IDs are fixture-only. Production sessions use `new()`.
    pub fn with_peer_id_for_fixture(peer_id: u64) -> DomainResult<Self> {
        let library = Self::new();
        library.doc.set_peer_id(peer_id).map_err(loro_error)?;
        Ok(library)
    }

    pub fn version(&self) -> VersionVector {
        self.doc.oplog_vv()
    }

    pub fn initialize_item(
        &self,
        item_id: &str,
        note: &str,
        title_revision: &str,
        title: &str,
        lifecycle_revision: &str,
    ) -> DomainResult<()> {
        self.note_mut(item_id)?
            .splice_utf16(0, 0, note)
            .map_err(loro_error)?;
        self.write_scalar(item_id, "title", title_revision, title)?;
        self.transition_lifecycle(item_id, lifecycle_revision, LifecycleState::Active)
    }

    pub fn splice_note_utf16(
        &self,
        item_id: &str,
        position: usize,
        length: usize,
        replacement: &str,
    ) -> DomainResult<()> {
        self.note_mut(item_id)?
            .splice_utf16(position, length, replacement)
            .map_err(loro_error)
    }

    pub fn write_scalar(
        &self,
        item_id: &str,
        field: &str,
        revision_id: &str,
        value: &str,
    ) -> DomainResult<()> {
        if field != "title" {
            return Err(DomainError::InvalidState(format!(
                "field {field:?} is not allowlisted"
            )));
        }
        let revisions = self.scalar_revisions_mut(item_id, field)?;
        let existing = read_records::<ScalarRevision>(&revisions)?;
        let revision = ScalarRevision {
            parents: causal_heads(&existing, |revision| &revision.parents),
            value: value.to_owned(),
        };
        insert_immutable_record(&revisions, revision_id, &revision)
    }

    pub fn add_tag(&self, item_id: &str, tag: &str, add_dot: &str) -> DomainResult<()> {
        let tag = normalize_tag(tag)?;
        let tags = self
            .item_mut(item_id)?
            .ensure_mergeable_map(TAGS)
            .map_err(loro_error)?;
        let state = tags.ensure_mergeable_map(&tag).map_err(loro_error)?;
        let adds = state.ensure_mergeable_map(ADDS).map_err(loro_error)?;
        insert_boolean_dot(&adds, add_dot)
    }

    pub fn remove_tag(&self, item_id: &str, tag: &str) -> DomainResult<()> {
        let tag = normalize_tag(tag)?;
        let tags = self
            .item_mut(item_id)?
            .ensure_mergeable_map(TAGS)
            .map_err(loro_error)?;
        let state = tags.ensure_mergeable_map(&tag).map_err(loro_error)?;
        let adds = state.ensure_mergeable_map(ADDS).map_err(loro_error)?;
        let removes = state.ensure_mergeable_map(REMOVES).map_err(loro_error)?;
        for add_dot in map_keys(&adds) {
            insert_boolean_dot(&removes, &add_dot)?;
        }
        Ok(())
    }

    pub fn transition_lifecycle(
        &self,
        item_id: &str,
        revision_id: &str,
        state: LifecycleState,
    ) -> DomainResult<()> {
        let revisions = self.lifecycle_revisions_mut(item_id)?;
        let existing = read_records::<LifecycleRevision>(&revisions)?;
        let parents = causal_heads(&existing, |revision| &revision.parents);
        if state == LifecycleState::Active && !existing.is_empty() {
            let visible = lifecycle_view(existing.clone())?;
            if visible.state != LifecycleState::Deleted {
                return Err(DomainError::InvalidState(
                    "restore requires an observed deleted lifecycle head".into(),
                ));
            }
        }
        let generation = parents
            .iter()
            .filter_map(|parent| existing.get(parent))
            .map(|revision| revision.generation)
            .max()
            .map_or(0, |generation| generation + 1);
        let revision = LifecycleRevision {
            generation,
            parents,
            state,
        };
        insert_immutable_record(&revisions, revision_id, &revision)
    }

    pub fn export_envelope(
        &self,
        from: &VersionVector,
        library_id: &str,
        device_id: &str,
        sequence: u64,
    ) -> DomainResult<UpdateEnvelope> {
        let update = self
            .doc
            .export(ExportMode::updates(from))
            .map_err(loro_error)?;
        Ok(UpdateEnvelope::new(
            library_id, device_id, sequence, from, &update,
        ))
    }

    pub fn import_envelope(&self, envelope: &UpdateEnvelope) -> DomainResult<()> {
        let payload = envelope.verified_payload()?;
        LoroDoc::decode_import_blob_meta(&payload, true).map_err(loro_error)?;
        self.doc.import(&payload).map_err(loro_error)?;
        Ok(())
    }

    pub fn canonical_projection(&self) -> DomainResult<CanonicalProjection> {
        let items = self.doc.get_map(ITEMS);
        let mut projected = BTreeMap::new();
        for item_id in map_keys(&items) {
            let item = map_child(&items, &item_id)?;
            // Explicit allowlist: title, note, tags, and lifecycle only.
            let scalars = map_child(&item, SCALARS)?;
            let title = map_child(&scalars, "title")?;
            let title_revisions = map_child(&title, REVISIONS)?;
            let title = scalar_view(read_records(&title_revisions)?)?;
            let note = text_child(&item, NOTE)?.to_string();
            let tags = project_tags(map_child(&item, TAGS)?)?;
            let lifecycle = map_child(&item, LIFECYCLE)?;
            let lifecycle_revisions = map_child(&lifecycle, REVISIONS)?;
            let lifecycle = lifecycle_view(read_records(&lifecycle_revisions)?)?;
            projected.insert(
                item_id,
                CanonicalItem {
                    title,
                    note,
                    tags,
                    lifecycle,
                },
            );
        }
        Ok(CanonicalProjection {
            schema_version: 1,
            items: projected,
        })
    }

    fn item_mut(&self, item_id: &str) -> DomainResult<LoroMap> {
        self.doc
            .get_map(ITEMS)
            .ensure_mergeable_map(item_id)
            .map_err(loro_error)
    }

    fn note_mut(&self, item_id: &str) -> DomainResult<LoroText> {
        self.item_mut(item_id)?
            .ensure_mergeable_text(NOTE)
            .map_err(loro_error)
    }

    fn scalar_revisions_mut(&self, item_id: &str, field: &str) -> DomainResult<LoroMap> {
        self.item_mut(item_id)?
            .ensure_mergeable_map(SCALARS)
            .map_err(loro_error)?
            .ensure_mergeable_map(field)
            .map_err(loro_error)?
            .ensure_mergeable_map(REVISIONS)
            .map_err(loro_error)
    }

    fn lifecycle_revisions_mut(&self, item_id: &str) -> DomainResult<LoroMap> {
        self.item_mut(item_id)?
            .ensure_mergeable_map(LIFECYCLE)
            .map_err(loro_error)?
            .ensure_mergeable_map(REVISIONS)
            .map_err(loro_error)
    }
}

impl Default for Library {
    fn default() -> Self {
        Self::new()
    }
}

fn loro_error(error: impl std::fmt::Display) -> DomainError {
    DomainError::Loro(error.to_string())
}

fn normalize_tag(tag: &str) -> DomainResult<String> {
    let normalized = tag.trim().to_lowercase();
    if normalized.is_empty() {
        return Err(DomainError::InvalidState("tag cannot be empty".into()));
    }
    Ok(normalized)
}

fn insert_boolean_dot(map: &LoroMap, dot: &str) -> DomainResult<()> {
    if let Some(existing) = map.get(dot) {
        if existing.get_deep_value().to_json_value() == serde_json::Value::Bool(true) {
            return Ok(());
        }
        return Err(DomainError::InvalidState(format!("dot collision at {dot}")));
    }
    map.insert(dot, true).map_err(loro_error)
}

fn insert_immutable_record<T: serde::Serialize>(
    map: &LoroMap,
    id: &str,
    record: &T,
) -> DomainResult<()> {
    let encoded = serde_json::to_string(record)?;
    if let Some(existing) = map.get(id) {
        if existing.get_deep_value().to_json_value().as_str() == Some(encoded.as_str()) {
            return Ok(());
        }
        return Err(DomainError::InvalidState(format!(
            "immutable revision collision at {id}"
        )));
    }
    map.insert(id, encoded).map_err(loro_error)
}

fn read_records<T: DeserializeOwned>(map: &LoroMap) -> DomainResult<BTreeMap<String, T>> {
    let mut raw = Vec::new();
    map.for_each(|key, value| {
        raw.push((key.to_owned(), value.get_deep_value().to_json_value()));
    });
    raw.into_iter()
        .map(|(key, value)| {
            let encoded = value.as_str().ok_or_else(|| {
                DomainError::InvalidState(format!("revision {key} is not encoded text"))
            })?;
            Ok((key, serde_json::from_str(encoded)?))
        })
        .collect()
}

fn map_keys(map: &LoroMap) -> Vec<String> {
    let mut keys = Vec::new();
    map.for_each(|key, _| keys.push(key.to_owned()));
    keys.sort();
    keys
}

fn map_child(parent: &LoroMap, key: &str) -> DomainResult<LoroMap> {
    match parent.get(key) {
        Some(ValueOrContainer::Container(Container::Map(map))) => Ok(map),
        _ => Err(DomainError::InvalidState(format!(
            "map child {key:?} is missing"
        ))),
    }
}

fn text_child(parent: &LoroMap, key: &str) -> DomainResult<LoroText> {
    match parent.get(key) {
        Some(ValueOrContainer::Container(Container::Text(text))) => Ok(text),
        _ => Err(DomainError::InvalidState(format!(
            "text child {key:?} is missing"
        ))),
    }
}

fn project_tags(tags: LoroMap) -> DomainResult<Vec<String>> {
    let mut visible = Vec::new();
    for tag in map_keys(&tags) {
        let state = map_child(&tags, &tag)?;
        let adds = map_child(&state, ADDS)?;
        let add_dots: BTreeSet<_> = map_keys(&adds).into_iter().collect();
        let removed_dots: BTreeSet<_> = match state.get(REMOVES) {
            Some(ValueOrContainer::Container(Container::Map(removes))) => {
                map_keys(&removes).into_iter().collect()
            }
            None => BTreeSet::new(),
            _ => {
                return Err(DomainError::InvalidState(format!(
                    "tag {tag:?} has an invalid remove set"
                )));
            }
        };
        if add_dots.iter().any(|dot| !removed_dots.contains(dot)) {
            visible.push(tag);
        }
    }
    Ok(visible)
}
