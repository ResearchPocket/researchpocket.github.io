use std::collections::{BTreeMap, BTreeSet};

use loro::{
    Container, EncodedBlobMode, ExportMode, LoroDoc, LoroMap, LoroText, ToJson,
    ValueOrContainer, VersionVector,
};
use serde::de::DeserializeOwned;
use serde::{Deserialize, Serialize};
use thiserror::Error;

use crate::{
    CanonicalItem, CanonicalProjection, LifecycleRevision, LifecycleState, ScalarRevision,
    ScalarView, UpdateEnvelope,
    identity::validate_uuid_v7,
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
const URL: &str = "url";
const TITLE: &str = "title";
const EXCERPT: &str = "excerpt";
const FAVORITE: &str = "favorite";
const LANGUAGE: &str = "language";
const SAVED_AT: &str = "saved_at";

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
    #[error("unsupported domain schema version {0}")]
    UnsupportedDomainSchema(u16),
    #[error("unsupported Loro codec {0}")]
    UnsupportedCodec(String),
    #[error("unsupported required protocol feature {0}")]
    UnsupportedFeature(String),
    #[error("unsupported operation pack version {0}")]
    UnsupportedOperationPackVersion(u8),
    #[error("integrity failure at {path}: expected {expected}, got {actual}")]
    Integrity {
        path: String,
        expected: String,
        actual: String,
    },
    #[error("invalid CRDT state: {0}")]
    InvalidState(String),
}

/// Complete canonical input for creating one URL-first library item.
///
/// The caller owns identity generation. `item_id` must be a canonical lowercase
/// UUIDv7 string, and `operation_prefix` passed to [`Library::create_item`] must
/// be unique for this item creation.
#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
pub struct ItemSeed {
    pub item_id: String,
    pub url: String,
    pub title: Option<String>,
    pub excerpt: Option<String>,
    pub favorite: bool,
    pub language: Option<String>,
    pub saved_at: i64,
    pub note: String,
    pub tags: Vec<String>,
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

    /// Start an empty replica with a caller-owned, durable Loro peer identity.
    ///
    /// JavaScript callers pass this identity as decimal text at the WASM
    /// boundary so it is never rounded through an IEEE-754 number.
    pub fn with_peer_id(peer_id: u64) -> DomainResult<Self> {
        let library = Self::new();
        library.doc.set_peer_id(peer_id).map_err(loro_error)?;
        Ok(library)
    }

    /// Fixture-facing alias that makes deterministic peer selection explicit.
    pub fn with_peer_id_for_fixture(peer_id: u64) -> DomainResult<Self> {
        Self::with_peer_id(peer_id)
    }

    /// Restore a complete local replica and assign a fresh peer ID for new work.
    pub fn from_snapshot(snapshot: &[u8], fresh_peer_id: u64) -> DomainResult<Self> {
        let metadata = LoroDoc::decode_import_blob_meta(snapshot, true).map_err(loro_error)?;
        if metadata.mode != EncodedBlobMode::Snapshot {
            return Err(DomainError::InvalidState(format!(
                "expected a full snapshot, got {}",
                metadata.mode
            )));
        }
        let library = Self::new();
        library.doc.set_peer_id(fresh_peer_id).map_err(loro_error)?;
        library.doc.import(snapshot).map_err(loro_error)?;
        Ok(library)
    }

    /// Export complete history and state for crash-safe local persistence.
    pub fn export_snapshot(&self) -> DomainResult<Vec<u8>> {
        self.doc.export(ExportMode::Snapshot).map_err(loro_error)
    }

    pub fn version(&self) -> VersionVector {
        self.doc.oplog_vv()
    }

    pub fn create_item(&self, seed: &ItemSeed, operation_prefix: &str) -> DomainResult<()> {
        validate_item_id(&seed.item_id)?;
        validate_operation_prefix(operation_prefix)?;
        validate_item_url(&seed.url)?;
        let tags = seed
            .tags
            .iter()
            .map(|tag| validate_tag(tag))
            .collect::<DomainResult<BTreeSet<_>>>()?;
        if self.doc.get_map(ITEMS).get(&seed.item_id).is_some() {
            return Err(DomainError::InvalidState(format!(
                "item {} already exists",
                seed.item_id
            )));
        }

        self.note_mut(&seed.item_id)?
            .splice_utf16(0, 0, &seed.note)
            .map_err(loro_error)?;
        self.write_url(
            &seed.item_id,
            &operation_id(operation_prefix, URL),
            &seed.url,
        )?;
        self.write_title(
            &seed.item_id,
            &operation_id(operation_prefix, TITLE),
            seed.title.as_deref(),
        )?;
        self.write_excerpt(
            &seed.item_id,
            &operation_id(operation_prefix, EXCERPT),
            seed.excerpt.as_deref(),
        )?;
        self.write_favorite(
            &seed.item_id,
            &operation_id(operation_prefix, FAVORITE),
            seed.favorite,
        )?;
        self.write_language(
            &seed.item_id,
            &operation_id(operation_prefix, LANGUAGE),
            seed.language.as_deref(),
        )?;
        self.write_saved_at(
            &seed.item_id,
            &operation_id(operation_prefix, SAVED_AT),
            seed.saved_at,
        )?;

        self.item_mut(&seed.item_id)?
            .ensure_mergeable_map(TAGS)
            .map_err(loro_error)?;
        for (index, tag) in tags.into_iter().enumerate() {
            self.add_tag(
                &seed.item_id,
                &tag,
                &operation_id(operation_prefix, &format!("tag/{index:020}")),
            )?;
        }
        self.transition_lifecycle(
            &seed.item_id,
            &operation_id(operation_prefix, LIFECYCLE),
            LifecycleState::Active,
        )
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

    pub fn write_url(&self, item_id: &str, revision_id: &str, value: &str) -> DomainResult<()> {
        validate_item_url(value)?;
        self.write_scalar(item_id, URL, revision_id, value.to_owned())
    }

    pub fn write_title(
        &self,
        item_id: &str,
        revision_id: &str,
        value: Option<&str>,
    ) -> DomainResult<()> {
        self.write_scalar(item_id, TITLE, revision_id, value.map(str::to_owned))
    }

    pub fn write_excerpt(
        &self,
        item_id: &str,
        revision_id: &str,
        value: Option<&str>,
    ) -> DomainResult<()> {
        self.write_scalar(item_id, EXCERPT, revision_id, value.map(str::to_owned))
    }

    pub fn write_favorite(
        &self,
        item_id: &str,
        revision_id: &str,
        value: bool,
    ) -> DomainResult<()> {
        self.write_scalar(item_id, FAVORITE, revision_id, value)
    }

    pub fn write_language(
        &self,
        item_id: &str,
        revision_id: &str,
        value: Option<&str>,
    ) -> DomainResult<()> {
        self.write_scalar(item_id, LANGUAGE, revision_id, value.map(str::to_owned))
    }

    pub fn write_saved_at(
        &self,
        item_id: &str,
        revision_id: &str,
        value: i64,
    ) -> DomainResult<()> {
        self.write_scalar(item_id, SAVED_AT, revision_id, value)
    }

    fn write_scalar<T>(
        &self,
        item_id: &str,
        field: &str,
        revision_id: &str,
        value: T,
    ) -> DomainResult<()>
    where
        T: Clone + DeserializeOwned + Serialize,
    {
        let revisions = self.scalar_revisions_mut(item_id, field)?;
        let existing = read_records::<ScalarRevision<T>>(&revisions)?;
        let revision = ScalarRevision {
            parents: causal_heads(&existing, |revision| &revision.parents),
            value,
        };
        insert_immutable_record(&revisions, revision_id, &revision)
    }

    pub fn add_tag(&self, item_id: &str, tag: &str, add_dot: &str) -> DomainResult<()> {
        let tag = validate_tag(tag)?;
        let tags = self
            .item_mut(item_id)?
            .ensure_mergeable_map(TAGS)
            .map_err(loro_error)?;
        let state = tags.ensure_mergeable_map(&tag).map_err(loro_error)?;
        let adds = state.ensure_mergeable_map(ADDS).map_err(loro_error)?;
        insert_boolean_dot(&adds, add_dot)
    }

    pub fn remove_tag(&self, item_id: &str, tag: &str) -> DomainResult<()> {
        let tag = validate_tag(tag)?;
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
        if !existing.is_empty() {
            let visible = lifecycle_view(existing.clone())?;
            match (visible.state, state) {
                (LifecycleState::Active, LifecycleState::Active) => {
                    return Err(DomainError::InvalidState(
                        "restore requires an observed deleted lifecycle head".into(),
                    ));
                }
                (LifecycleState::Deleted, LifecycleState::Deleted) => {
                    return Err(DomainError::InvalidState(
                        "delete requires an observed active lifecycle head".into(),
                    ));
                }
                _ => {}
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
        created_at: &str,
    ) -> DomainResult<UpdateEnvelope> {
        if created_at.trim().is_empty() {
            return Err(DomainError::InvalidState(
                "envelope creation time cannot be blank".into(),
            ));
        }
        let update = self
            .doc
            .export(ExportMode::updates(from))
            .map_err(loro_error)?;
        UpdateEnvelope::new(library_id, device_id, sequence, from, created_at, &update)
    }

    pub fn import_envelope(&self, envelope: &UpdateEnvelope) -> DomainResult<()> {
        self.import_envelope_has_pending(envelope).map(|_| ())
    }

    pub fn import_envelope_has_pending(&self, envelope: &UpdateEnvelope) -> DomainResult<bool> {
        let payload = envelope.verified_payload()?;
        LoroDoc::decode_import_blob_meta(&payload, true).map_err(loro_error)?;
        let status = self.doc.import(&payload).map_err(loro_error)?;
        Ok(status.pending.is_some())
    }

    pub fn canonical_projection(&self) -> DomainResult<CanonicalProjection> {
        let items = self.doc.get_map(ITEMS);
        let mut projected = BTreeMap::new();
        for item_id in map_keys(&items) {
            let item = map_child(&items, &item_id)?;
            // Explicit allowlist: canonical scalar values, note, tags, and lifecycle only.
            let scalars = map_child(&item, SCALARS)?;
            let url = project_scalar::<String>(&scalars, URL)?;
            let title = project_scalar::<Option<String>>(&scalars, TITLE)?;
            let excerpt = project_scalar::<Option<String>>(&scalars, EXCERPT)?;
            let favorite = project_scalar::<bool>(&scalars, FAVORITE)?;
            let language = project_scalar::<Option<String>>(&scalars, LANGUAGE)?;
            let saved_at = project_scalar::<i64>(&scalars, SAVED_AT)?;
            let note = text_child(&item, NOTE)?.to_string();
            let tags = project_tags(map_child(&item, TAGS)?)?;
            let lifecycle = map_child(&item, LIFECYCLE)?;
            let lifecycle_revisions = map_child(&lifecycle, REVISIONS)?;
            let lifecycle = lifecycle_view(read_records(&lifecycle_revisions)?)?;
            projected.insert(
                item_id,
                CanonicalItem {
                    url,
                    title,
                    excerpt,
                    favorite,
                    language,
                    saved_at,
                    note,
                    tags,
                    lifecycle,
                },
            );
        }
        Ok(CanonicalProjection {
            schema_version: 2,
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

fn validate_item_id(item_id: &str) -> DomainResult<()> {
    validate_uuid_v7(item_id, "item ID")
}

fn validate_operation_prefix(prefix: &str) -> DomainResult<()> {
    if prefix.trim().is_empty() {
        return Err(DomainError::InvalidState(
            "operation prefix cannot be blank".into(),
        ));
    }
    Ok(())
}

pub fn validate_item_url(url: &str) -> DomainResult<()> {
    let parsed = url::Url::parse(url)
        .map_err(|_| DomainError::InvalidState("URL must be an absolute HTTP(S) URL".into()))?;
    if !matches!(parsed.scheme(), "http" | "https") || parsed.host_str().is_none() {
        return Err(DomainError::InvalidState(
            "URL must be an absolute HTTP(S) URL".into(),
        ));
    }
    Ok(())
}

fn validate_tag(tag: &str) -> DomainResult<String> {
    if tag.trim().is_empty() {
        return Err(DomainError::InvalidState("tag cannot be empty".into()));
    }
    Ok(tag.to_owned())
}

fn operation_id(prefix: &str, suffix: &str) -> String {
    format!("{prefix}/{suffix}")
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

fn project_scalar<T>(scalars: &LoroMap, field: &str) -> DomainResult<ScalarView<T>>
where
    T: Clone + DeserializeOwned,
{
    let scalar = map_child(scalars, field)?;
    let revisions = map_child(&scalar, REVISIONS)?;
    scalar_view(read_records(&revisions)?)
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
