use std::collections::BTreeMap;

use base64::{Engine as _, engine::general_purpose::STANDARD};
use chrono::{DateTime, FixedOffset};
use loro::VersionVector;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

use crate::{
    CanonicalItem, CanonicalProjection, DOMAIN_SCHEMA_VERSION, DomainError, DomainResult,
    ItemSeed, LORO_CODEC, Library, LifecycleState, identity::validate_uuid_v7,
};

pub const AGGREGATE_PROTOCOL_VERSION: u8 = 2;
pub const ITEM_AGGREGATES_FEATURE: &str = "item-aggregates-v2";
pub const AGGREGATE_GENESIS_PATH: &str = "sync/v2/library.json";
pub const AGGREGATE_OPS_ROOT: &str = "sync/v2/ops/";
pub const AGGREGATE_CHECKPOINTS_ROOT: &str = "sync/v2/checkpoints/";
pub const AGGREGATE_CATALOGUE_PREFIX: &str = "sync/v2/catalogue/";

/// Location of a catalogue.
///
/// Genesis binds the catalogue by hash rather than by name, so the artifact is
/// addressed by that same hash. A catalogue is immutable like every other v2
/// object: a new library state produces a new path, never a rewrite.
pub fn aggregate_catalogue_path(catalogue_sha256: &str) -> String {
    format!("{AGGREGATE_CATALOGUE_PREFIX}{catalogue_sha256}.json")
}
pub const ITEM_OPS_PREFIX: &str = "sync/v2/ops/items/";
pub const ITEM_CHECKPOINTS_PREFIX: &str = "sync/v2/checkpoints/items/";

/// Which kind of aggregate an operation, checkpoint, or catalogue entry
/// describes.
///
/// An unrecognized kind deserializes into [`AggregateKind::Unsupported`] rather
/// than failing to parse. That distinction matters: a client that cannot tell
/// "written by a newer client" from "malformed" would either reject a valid
/// repository or, worse, skip the entry and materialize a partial library.
/// Carrying the unknown name lets every consumer fail closed with an
/// upgrade-shaped error instead.
#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(from = "String", into = "String")]
pub enum AggregateKind {
    Item,
    Unsupported(String),
}

impl AggregateKind {
    pub fn as_str(&self) -> &str {
        match self {
            Self::Item => "item",
            Self::Unsupported(value) => value,
        }
    }

    /// Repository path segment for this kind.
    ///
    /// Fails closed for a kind this build does not implement, which is what
    /// stops an older client from writing to or reading around a namespace it
    /// does not understand.
    pub fn path_segment(&self) -> DomainResult<&'static str> {
        match self {
            Self::Item => Ok("items"),
            Self::Unsupported(value) => {
                Err(DomainError::UnsupportedAggregateKind(value.clone()))
            }
        }
    }

    pub fn ops_prefix(&self) -> DomainResult<String> {
        Ok(format!("{AGGREGATE_OPS_ROOT}{}/", self.path_segment()?))
    }

    pub fn checkpoints_prefix(&self) -> DomainResult<String> {
        Ok(format!(
            "{AGGREGATE_CHECKPOINTS_ROOT}{}/",
            self.path_segment()?
        ))
    }

    pub fn checkpoint_path(
        &self,
        aggregate_id: &str,
        snapshot_sha256: &str,
    ) -> DomainResult<String> {
        Ok(format!(
            "{}{aggregate_id}/{snapshot_sha256}.json",
            self.checkpoints_prefix()?
        ))
    }
}

impl From<String> for AggregateKind {
    fn from(value: String) -> Self {
        match value.as_str() {
            "item" => Self::Item,
            _ => Self::Unsupported(value),
        }
    }
}

impl From<AggregateKind> for String {
    fn from(value: AggregateKind) -> Self {
        value.as_str().to_owned()
    }
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct AggregateEnvelope {
    pub protocol_version: u8,
    pub domain_schema_version: u16,
    pub loro_codec: String,
    pub required_features: Vec<String>,
    pub aggregate_kind: AggregateKind,
    pub aggregate_id: String,
    pub library_id: String,
    pub device_id: String,
    pub sequence: String,
    pub causal_frontier: BTreeMap<String, i32>,
    pub created_at: String,
    pub payload: String,
    pub payload_sha256: String,
}

impl AggregateEnvelope {
    pub fn path(&self) -> DomainResult<String> {
        Ok(format!(
            "{}{}/{}/{}.json",
            self.aggregate_kind.ops_prefix()?,
            self.aggregate_id,
            self.device_id,
            self.sequence
        ))
    }

    pub fn validate(
        &self,
        path: &str,
        expected_library_id: &str,
        expected_aggregate_id: &str,
    ) -> DomainResult<Vec<u8>> {
        if self.protocol_version != AGGREGATE_PROTOCOL_VERSION {
            return Err(DomainError::UnsupportedProtocol(self.protocol_version));
        }
        if self.domain_schema_version > DOMAIN_SCHEMA_VERSION {
            return Err(DomainError::UnsupportedDomainSchema(
                self.domain_schema_version,
            ));
        }
        if self.loro_codec != LORO_CODEC {
            return Err(DomainError::UnsupportedCodec(self.loro_codec.clone()));
        }
        if self.required_features != [ITEM_AGGREGATES_FEATURE] {
            return Err(DomainError::UnsupportedFeature(
                self.required_features
                    .first()
                    .cloned()
                    .unwrap_or_else(|| "missing-item-aggregates-v2".into()),
            ));
        }
        self.aggregate_kind.path_segment()?;
        for (value, label) in [
            (self.aggregate_id.as_str(), "aggregate ID"),
            (self.library_id.as_str(), "library ID"),
            (self.device_id.as_str(), "device ID"),
            (expected_library_id, "expected library ID"),
            (expected_aggregate_id, "expected aggregate ID"),
        ] {
            validate_uuid_v7(value, label)?;
        }
        if self.library_id != expected_library_id || self.aggregate_id != expected_aggregate_id
        {
            return Err(DomainError::Integrity {
                path: path.to_owned(),
                expected: format!("{expected_library_id}/{expected_aggregate_id}"),
                actual: format!("{}/{}", self.library_id, self.aggregate_id),
            });
        }
        let expected_path = self.path()?;
        if path != expected_path {
            return Err(DomainError::Integrity {
                path: path.to_owned(),
                expected: expected_path,
                actual: path.to_owned(),
            });
        }
        validate_sequence(&self.sequence)?;
        validate_utc(&self.created_at, "aggregate operation creation time")?;
        validate_frontier(&self.causal_frontier)?;
        let payload = STANDARD.decode(&self.payload)?;
        let actual = sha256_hex(&payload);
        if actual != self.payload_sha256 {
            return Err(DomainError::Integrity {
                path: path.to_owned(),
                expected: self.payload_sha256.clone(),
                actual,
            });
        }
        Ok(payload)
    }
}

pub struct ItemAggregate {
    item_id: String,
    library: Library,
}

impl ItemAggregate {
    pub fn from_snapshot(item_id: &str, snapshot: &[u8], peer_id: u64) -> DomainResult<Self> {
        validate_uuid_v7(item_id, "item aggregate ID")?;
        let library = Library::from_snapshot(snapshot, peer_id)?;
        validate_single_item(&library, item_id)?;
        Ok(Self {
            item_id: item_id.to_owned(),
            library,
        })
    }

    pub fn from_canonical(
        item_id: &str,
        item: &CanonicalItem,
        migration_checkpoint_id: &str,
        peer_id: u64,
    ) -> DomainResult<Self> {
        validate_uuid_v7(item_id, "item aggregate ID")?;
        validate_sha256(migration_checkpoint_id, "migration checkpoint ID")?;
        let library = Library::with_peer_id(peer_id)?;
        let prefix = format!("migration/{migration_checkpoint_id}/{item_id}");
        library.create_item(
            &ItemSeed {
                item_id: item_id.to_owned(),
                url: item.url.value.clone(),
                title: item.title.value.clone(),
                excerpt: (!item.excerpt.is_empty()).then(|| item.excerpt.clone()),
                favorite: item.favorite.value,
                language: item.language.value.clone(),
                saved_at: item.saved_at.value,
                note: item.note.clone(),
                tags: item.tags.clone(),
            },
            &prefix,
        )?;
        if let Some(reference) = item
            .captured_document
            .as_ref()
            .and_then(|view| view.value.as_ref())
        {
            library.write_captured_document(
                item_id,
                &format!("{prefix}/captured-document"),
                Some(reference),
            )?;
        }
        if item.lifecycle.state == LifecycleState::Deleted {
            library.transition_lifecycle(
                item_id,
                &format!("{prefix}/deleted"),
                LifecycleState::Deleted,
            )?;
        }
        Ok(Self {
            item_id: item_id.to_owned(),
            library,
        })
    }

    pub fn item_id(&self) -> &str {
        &self.item_id
    }

    pub fn library(&self) -> &Library {
        &self.library
    }

    pub fn version(&self) -> VersionVector {
        self.library.version()
    }

    pub fn export_snapshot(&self) -> DomainResult<Vec<u8>> {
        self.library.export_snapshot()
    }

    pub fn canonical_item(&self) -> DomainResult<CanonicalItem> {
        self.library
            .canonical_projection()?
            .items
            .remove(&self.item_id)
            .ok_or_else(|| DomainError::InvalidState("item aggregate body is missing".into()))
    }

    #[allow(clippy::too_many_arguments)]
    pub fn export_envelope(
        &self,
        from: &VersionVector,
        library_id: &str,
        device_id: &str,
        sequence: u64,
        created_at: &str,
    ) -> DomainResult<AggregateEnvelope> {
        validate_uuid_v7(library_id, "library ID")?;
        validate_uuid_v7(device_id, "device ID")?;
        validate_utc(created_at, "aggregate operation creation time")?;
        if sequence == 0 {
            return Err(DomainError::InvalidState(
                "aggregate operation sequence cannot be zero".into(),
            ));
        }
        let update = self.library.export_update(from)?;
        let envelope = AggregateEnvelope {
            protocol_version: AGGREGATE_PROTOCOL_VERSION,
            domain_schema_version: DOMAIN_SCHEMA_VERSION,
            loro_codec: LORO_CODEC.to_owned(),
            required_features: vec![ITEM_AGGREGATES_FEATURE.to_owned()],
            aggregate_kind: AggregateKind::Item,
            aggregate_id: self.item_id.clone(),
            library_id: library_id.to_owned(),
            device_id: device_id.to_owned(),
            sequence: format!("{sequence:020}"),
            causal_frontier: from
                .iter()
                .map(|(peer, counter)| (peer.to_string(), *counter))
                .collect(),
            created_at: created_at.to_owned(),
            payload: STANDARD.encode(&update),
            payload_sha256: sha256_hex(&update),
        };
        envelope.validate(&envelope.path()?, library_id, &self.item_id)?;
        Ok(envelope)
    }

    pub fn import_envelope(
        &self,
        path: &str,
        envelope: &AggregateEnvelope,
        expected_library_id: &str,
    ) -> DomainResult<bool> {
        if envelope.aggregate_kind != AggregateKind::Item {
            return Err(DomainError::UnsupportedAggregateKind(
                envelope.aggregate_kind.as_str().to_owned(),
            ));
        }
        let payload = envelope.validate(path, expected_library_id, &self.item_id)?;
        self.library.import_update(&payload)
    }
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ItemAggregateCheckpoint {
    pub aggregate_id: String,
    pub snapshot_sha256: String,
    pub snapshot_base64: String,
}

impl ItemAggregateCheckpoint {
    pub fn path(&self) -> String {
        format!(
            "{ITEM_CHECKPOINTS_PREFIX}{}/{}.json",
            self.aggregate_id, self.snapshot_sha256
        )
    }

    pub fn validate(&self, path: &str, peer_id: u64) -> DomainResult<ItemAggregate> {
        validate_uuid_v7(&self.aggregate_id, "item aggregate ID")?;
        validate_sha256(&self.snapshot_sha256, "item snapshot SHA-256")?;
        if path != self.path() {
            return Err(DomainError::Integrity {
                path: path.to_owned(),
                expected: self.path(),
                actual: path.to_owned(),
            });
        }
        let snapshot = STANDARD.decode(&self.snapshot_base64)?;
        let actual = sha256_hex(&snapshot);
        if actual != self.snapshot_sha256 {
            return Err(DomainError::Integrity {
                path: path.to_owned(),
                expected: self.snapshot_sha256.clone(),
                actual,
            });
        }
        ItemAggregate::from_snapshot(&self.aggregate_id, &snapshot, peer_id)
    }
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct CatalogueEntry {
    pub aggregate_kind: AggregateKind,
    pub aggregate_id: String,
    pub saved_at: i64,
    pub state: LifecycleState,
    pub checkpoint_path: String,
    pub snapshot_sha256: String,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct AggregateCatalogue {
    pub protocol_version: u8,
    pub library_id: String,
    pub migrated_from_v1_checkpoint: String,
    pub entries: Vec<CatalogueEntry>,
}

impl AggregateCatalogue {
    /// Content-addressed location of this catalogue's exact serialized bytes.
    pub fn path(&self) -> DomainResult<String> {
        Ok(aggregate_catalogue_path(&sha256_hex(
            serde_json::to_string(self)?.as_bytes(),
        )))
    }

    /// Validates a catalogue before any of its aggregates are trusted.
    ///
    /// Entries are required to be strictly ascending by `(kind, aggregate_id)`
    /// so the artifact is byte-identical for a given library state and so
    /// duplicates cannot hide a second definition of one aggregate.
    pub fn validate(&self, expected_library_id: &str) -> DomainResult<()> {
        if self.protocol_version != AGGREGATE_PROTOCOL_VERSION {
            return Err(DomainError::UnsupportedProtocol(self.protocol_version));
        }
        validate_uuid_v7(&self.library_id, "catalogue library ID")?;
        validate_uuid_v7(expected_library_id, "expected library ID")?;
        if self.library_id != expected_library_id {
            return Err(DomainError::Integrity {
                path: self.path()?,
                expected: expected_library_id.to_owned(),
                actual: self.library_id.clone(),
            });
        }
        validate_sha256(
            &self.migrated_from_v1_checkpoint,
            "catalogue v1 checkpoint ID",
        )?;
        let mut previous: Option<(&str, &str)> = None;
        for entry in &self.entries {
            // Fails closed: a kind this build does not implement must stop the
            // whole catalogue rather than materialize a partial library.
            entry.aggregate_kind.path_segment()?;
            validate_uuid_v7(&entry.aggregate_id, "catalogue aggregate ID")?;
            validate_sha256(&entry.snapshot_sha256, "catalogue snapshot SHA-256")?;
            let expected_path = entry
                .aggregate_kind
                .checkpoint_path(&entry.aggregate_id, &entry.snapshot_sha256)?;
            // Anchored on the entry's own checkpoint path, so a mismatch names
            // the object a reader would go fetch.
            if entry.checkpoint_path != expected_path {
                return Err(DomainError::Integrity {
                    path: entry.checkpoint_path.clone(),
                    expected: expected_path,
                    actual: entry.checkpoint_path.clone(),
                });
            }
            let current = (entry.aggregate_kind.as_str(), entry.aggregate_id.as_str());
            if previous.is_some_and(|previous| previous >= current) {
                return Err(DomainError::InvalidState(
                    "catalogue entries are not strictly ascending by kind and aggregate ID"
                        .into(),
                ));
            }
            previous = Some(current);
        }
        Ok(())
    }
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct AggregateGenesis {
    pub protocol_version: u8,
    pub required_features: Vec<String>,
    pub library_id: String,
    pub created_at: String,
    pub migrated_from_v1_checkpoint: String,
    pub catalogue_sha256: String,
}

impl AggregateGenesis {
    /// Validates genesis and binds it to the exact catalogue bytes it declares.
    pub fn validate(
        &self,
        expected_library_id: &str,
        catalogue_json: &str,
    ) -> DomainResult<AggregateCatalogue> {
        if self.protocol_version != AGGREGATE_PROTOCOL_VERSION {
            return Err(DomainError::UnsupportedProtocol(self.protocol_version));
        }
        // Unknown features are reported before exactness so a newer writer
        // always surfaces as "upgrade", never as "malformed".
        if let Some(unknown) = self
            .required_features
            .iter()
            .find(|feature| feature.as_str() != ITEM_AGGREGATES_FEATURE)
        {
            return Err(DomainError::UnsupportedFeature(unknown.clone()));
        }
        if self.required_features.is_empty() {
            return Err(DomainError::UnsupportedFeature(
                "missing-item-aggregates-v2".into(),
            ));
        }
        if self.required_features != [ITEM_AGGREGATES_FEATURE] {
            return Err(DomainError::InvalidState(
                "genesis required features are not canonical".into(),
            ));
        }
        validate_uuid_v7(&self.library_id, "genesis library ID")?;
        validate_uuid_v7(expected_library_id, "expected library ID")?;
        if self.library_id != expected_library_id {
            return Err(DomainError::Integrity {
                path: AGGREGATE_GENESIS_PATH.to_owned(),
                expected: expected_library_id.to_owned(),
                actual: self.library_id.clone(),
            });
        }
        validate_utc(&self.created_at, "aggregate genesis creation time")?;
        validate_sha256(
            &self.migrated_from_v1_checkpoint,
            "genesis v1 checkpoint ID",
        )?;
        validate_sha256(&self.catalogue_sha256, "genesis catalogue SHA-256")?;
        let actual = sha256_hex(catalogue_json.as_bytes());
        if actual != self.catalogue_sha256 {
            return Err(DomainError::Integrity {
                path: AGGREGATE_GENESIS_PATH.to_owned(),
                expected: self.catalogue_sha256.clone(),
                actual,
            });
        }
        let catalogue: AggregateCatalogue = serde_json::from_str(catalogue_json)?;
        catalogue.validate(expected_library_id)?;
        if catalogue.migrated_from_v1_checkpoint != self.migrated_from_v1_checkpoint {
            return Err(DomainError::Integrity {
                path: AGGREGATE_GENESIS_PATH.to_owned(),
                expected: self.migrated_from_v1_checkpoint.clone(),
                actual: catalogue.migrated_from_v1_checkpoint,
            });
        }
        Ok(catalogue)
    }
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct AggregateMigration {
    pub genesis_json: String,
    pub catalogue_json: String,
    pub catalogue_sha256: String,
    pub checkpoints: Vec<(String, String)>,
}

pub fn create_aggregate_migration(
    projection: &CanonicalProjection,
    library_id: &str,
    v1_checkpoint_id: &str,
    created_at: &str,
    peer_id: u64,
) -> DomainResult<AggregateMigration> {
    validate_uuid_v7(library_id, "library ID")?;
    validate_sha256(v1_checkpoint_id, "v1 checkpoint ID")?;
    validate_utc(created_at, "aggregate genesis creation time")?;
    let mut entries = Vec::with_capacity(projection.items.len());
    let mut checkpoints = Vec::with_capacity(projection.items.len());
    for (item_id, item) in &projection.items {
        let aggregate =
            ItemAggregate::from_canonical(item_id, item, v1_checkpoint_id, peer_id)?;
        let snapshot = aggregate.export_snapshot()?;
        let checkpoint = ItemAggregateCheckpoint {
            aggregate_id: item_id.clone(),
            snapshot_sha256: sha256_hex(&snapshot),
            snapshot_base64: STANDARD.encode(snapshot),
        };
        let checkpoint_path = checkpoint.path();
        entries.push(CatalogueEntry {
            aggregate_kind: AggregateKind::Item,
            aggregate_id: item_id.clone(),
            saved_at: item.saved_at.value,
            state: item.lifecycle.state,
            checkpoint_path: checkpoint_path.clone(),
            snapshot_sha256: checkpoint.snapshot_sha256.clone(),
        });
        checkpoints.push((checkpoint_path, serde_json::to_string(&checkpoint)?));
    }
    let catalogue = AggregateCatalogue {
        protocol_version: AGGREGATE_PROTOCOL_VERSION,
        library_id: library_id.to_owned(),
        migrated_from_v1_checkpoint: v1_checkpoint_id.to_owned(),
        entries,
    };
    catalogue.validate(library_id)?;
    let catalogue_json = serde_json::to_string(&catalogue)?;
    let catalogue_sha256 = sha256_hex(catalogue_json.as_bytes());
    let genesis = AggregateGenesis {
        protocol_version: AGGREGATE_PROTOCOL_VERSION,
        required_features: vec![ITEM_AGGREGATES_FEATURE.to_owned()],
        library_id: library_id.to_owned(),
        created_at: created_at.to_owned(),
        migrated_from_v1_checkpoint: v1_checkpoint_id.to_owned(),
        catalogue_sha256: catalogue_sha256.clone(),
    };
    let genesis_json = serde_json::to_string(&genesis)?;
    genesis.validate(library_id, &catalogue_json)?;
    Ok(AggregateMigration {
        genesis_json,
        catalogue_json,
        catalogue_sha256,
        checkpoints,
    })
}

fn validate_single_item(library: &Library, item_id: &str) -> DomainResult<()> {
    let projection = library.canonical_projection()?;
    if projection.items.len() != 1 || !projection.items.contains_key(item_id) {
        return Err(DomainError::InvalidState(
            "item aggregate snapshot does not contain exactly its declared item".into(),
        ));
    }
    Ok(())
}

fn validate_sequence(value: &str) -> DomainResult<()> {
    if value.len() != 20
        || !value.bytes().all(|byte| byte.is_ascii_digit())
        || value == "00000000000000000000"
        || value.parse::<u64>().is_err()
    {
        return Err(DomainError::InvalidState(
            "aggregate sequence is not a nonzero fixed-width u64".into(),
        ));
    }
    Ok(())
}

fn validate_frontier(frontier: &BTreeMap<String, i32>) -> DomainResult<()> {
    for (peer, counter) in frontier {
        if peer.parse::<u64>().is_err() || *counter < 0 {
            return Err(DomainError::InvalidState(
                "aggregate causal frontier is invalid".into(),
            ));
        }
    }
    Ok(())
}

fn validate_utc(value: &str, label: &str) -> DomainResult<()> {
    let parsed = DateTime::<FixedOffset>::parse_from_rfc3339(value)
        .map_err(|_| DomainError::InvalidState(format!("{label} is not RFC 3339")))?;
    if parsed.offset().local_minus_utc() != 0 {
        return Err(DomainError::InvalidState(format!("{label} is not UTC")));
    }
    Ok(())
}

fn validate_sha256(value: &str, label: &str) -> DomainResult<()> {
    if value.len() != 64
        || !value
            .bytes()
            .all(|byte| byte.is_ascii_digit() || matches!(byte, b'a'..=b'f'))
    {
        return Err(DomainError::InvalidState(format!(
            "{label} is not lowercase SHA-256"
        )));
    }
    Ok(())
}

fn sha256_hex(bytes: &[u8]) -> String {
    Sha256::digest(bytes)
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{CapturedDocumentProvenance, CapturedDocumentRef, ScalarRevision, ScalarView};

    const LIBRARY: &str = "00000000-0000-7000-8000-000000000001";
    const DEVICE: &str = "00000000-0000-7000-8000-000000000002";
    const ITEM: &str = "0197f2b5-93d7-7ad4-8c67-21e98f0c7341";
    const CHECKPOINT: &str = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";

    fn scalar<T: Clone>(value: T, suffix: &str) -> ScalarView<T> {
        let winner = format!("migration/{suffix}");
        ScalarView {
            value: value.clone(),
            winner: winner.clone(),
            heads: vec![winner.clone()],
            revisions: BTreeMap::from([(
                winner,
                ScalarRevision {
                    parents: Vec::new(),
                    value,
                },
            )]),
        }
    }

    fn item() -> CanonicalItem {
        CanonicalItem {
            url: scalar("https://example.com".to_owned(), "url"),
            title: scalar(Some("Title".to_owned()), "title"),
            excerpt: "Authored summary".into(),
            favorite: scalar(false, "favorite"),
            language: scalar(Some("en".to_owned()), "language"),
            saved_at: scalar(1_700_000_000, "saved-at"),
            captured_document: Some(scalar(
                Some(CapturedDocumentRef {
                    sha256: "b".repeat(64),
                    byte_length: 1_000_000,
                    media_type: "text/markdown; charset=utf-8".into(),
                    provenance: CapturedDocumentProvenance {
                        provider: "firecrawl".into(),
                        source_url: "https://example.com".into(),
                        captured_at: "2026-07-28T00:00:00Z".into(),
                    },
                }),
                "captured",
            )),
            note: "Private note".into(),
            tags: vec!["reference".into()],
            lifecycle: crate::LifecycleView {
                state: LifecycleState::Active,
                generation: 0,
                heads: vec!["migration/lifecycle".into()],
                revisions: BTreeMap::from([(
                    "migration/lifecycle".into(),
                    crate::LifecycleRevision {
                        generation: 0,
                        parents: Vec::new(),
                        state: LifecycleState::Active,
                    },
                )]),
            },
        }
    }

    #[test]
    fn item_envelopes_are_scoped_and_converge_without_document_bytes() {
        let aggregate =
            ItemAggregate::from_canonical(ITEM, &item(), CHECKPOINT, 11).expect("aggregate");
        let base_snapshot = aggregate.export_snapshot().expect("base snapshot");
        let before = aggregate.version();
        aggregate
            .library()
            .write_title(ITEM, "device/1/title", Some("Changed"))
            .expect("edit title");
        let envelope = aggregate
            .export_envelope(&before, LIBRARY, DEVICE, 1, "2026-07-28T00:00:01Z")
            .expect("envelope");
        let path = envelope.path().expect("path");
        assert!(path.contains(ITEM));
        assert!(
            !serde_json::to_string(&envelope)
                .unwrap()
                .contains(&"x".repeat(100))
        );

        let base = ItemAggregate::from_snapshot(ITEM, &base_snapshot, 22).expect("base");
        base.import_envelope(&path, &envelope, LIBRARY)
            .expect("apply");
        assert_eq!(
            base.canonical_item().unwrap().title.value.as_deref(),
            Some("Changed")
        );
    }

    #[test]
    fn migration_catalogue_contains_references_but_no_captured_bytes() {
        let projection = CanonicalProjection {
            schema_version: 3,
            items: BTreeMap::from([(ITEM.to_owned(), item())]),
        };
        let migration = create_aggregate_migration(
            &projection,
            LIBRARY,
            CHECKPOINT,
            "2026-07-28T00:00:00Z",
            31,
        )
        .expect("migration");
        let repeated = create_aggregate_migration(
            &projection,
            LIBRARY,
            CHECKPOINT,
            "2026-07-28T00:00:00Z",
            31,
        )
        .expect("repeated migration");
        assert_eq!(migration.genesis_json, repeated.genesis_json);
        assert_eq!(migration.catalogue_json, repeated.catalogue_json);
        assert_eq!(migration.checkpoints, repeated.checkpoints);
        assert_eq!(migration.checkpoints.len(), 1);
        assert!(!migration.catalogue_json.contains("markdown"));
        let (path, json) = &migration.checkpoints[0];
        let checkpoint: ItemAggregateCheckpoint = serde_json::from_str(json).unwrap();
        checkpoint.validate(path, 32).expect("checkpoint");
    }

    /// A newer client's aggregate kind must stop an older client outright.
    ///
    /// Ignoring the entry would silently materialize a partial library, which
    /// is the failure mode the fail-closed migration boundary exists to
    /// prevent.
    #[test]
    fn unknown_aggregate_kind_fails_closed_everywhere() {
        assert_eq!(
            AggregateKind::Item.ops_prefix().unwrap(),
            ITEM_OPS_PREFIX,
            "item paths must stay byte-identical now that they are kind-derived"
        );
        assert_eq!(
            AggregateKind::Item
                .checkpoint_path(ITEM, &"c".repeat(64))
                .unwrap(),
            ItemAggregateCheckpoint {
                aggregate_id: ITEM.to_owned(),
                snapshot_sha256: "c".repeat(64),
                snapshot_base64: String::new(),
            }
            .path()
        );

        let projection = CanonicalProjection {
            schema_version: 3,
            items: BTreeMap::from([(ITEM.to_owned(), item())]),
        };
        let migration = create_aggregate_migration(
            &projection,
            LIBRARY,
            CHECKPOINT,
            "2026-07-28T00:00:00Z",
            51,
        )
        .expect("migration");

        // An unrecognized kind still parses, so the client can report an
        // upgrade rather than a corrupt repository.
        let future = migration
            .catalogue_json
            .replace(r#""item""#, r#""zen_document""#);
        let catalogue: AggregateCatalogue =
            serde_json::from_str(&future).expect("unknown kind still parses");
        assert_eq!(
            catalogue.entries[0].aggregate_kind,
            AggregateKind::Unsupported("zen_document".into())
        );
        assert!(matches!(
            catalogue.validate(LIBRARY),
            Err(DomainError::UnsupportedAggregateKind(kind)) if kind == "zen_document"
        ));

        let genesis: AggregateGenesis =
            serde_json::from_str(&migration.genesis_json).expect("genesis");
        assert!(genesis.validate(LIBRARY, &migration.catalogue_json).is_ok());
        // Genesis is bound to exact catalogue bytes.
        assert!(matches!(
            genesis.validate(LIBRARY, &future),
            Err(DomainError::Integrity { .. })
        ));
        let mut duplicated = genesis.clone();
        duplicated
            .required_features
            .push(ITEM_AGGREGATES_FEATURE.to_owned());
        assert!(
            matches!(
                duplicated.validate(LIBRARY, &migration.catalogue_json),
                Err(DomainError::InvalidState(_))
            ),
            "a non-canonical feature list must not validate"
        );

        let aggregate =
            ItemAggregate::from_canonical(ITEM, &item(), CHECKPOINT, 52).expect("aggregate");
        let mut envelope = aggregate
            .export_envelope(
                &aggregate.version(),
                LIBRARY,
                DEVICE,
                1,
                "2026-07-28T00:00:01Z",
            )
            .expect("envelope");
        let path = envelope.path().expect("path");
        envelope.aggregate_kind = AggregateKind::Unsupported("zen_document".into());
        assert!(matches!(
            envelope.path(),
            Err(DomainError::UnsupportedAggregateKind(_))
        ));
        assert!(matches!(
            aggregate.import_envelope(&path, &envelope, LIBRARY),
            Err(DomainError::UnsupportedAggregateKind(_))
        ));
    }

    #[test]
    fn recognized_v1_barrier_is_accepted_but_unknown_features_fail_closed() {
        let library =
            ItemAggregate::from_canonical(ITEM, &item(), CHECKPOINT, 41).expect("aggregate");
        let before = library.library().version();
        let barrier = library
            .library()
            .export_item_aggregates_migration_barrier(
                &before,
                LIBRARY,
                DEVICE,
                1,
                "2026-07-28T00:00:00Z",
            )
            .expect("barrier");
        let replica =
            ItemAggregate::from_snapshot(ITEM, &library.export_snapshot().unwrap(), 42)
                .expect("replica");
        replica
            .library()
            .import_envelope(&barrier)
            .expect("new client accepts barrier");
        let mut future = barrier;
        future.required_features.push("future-feature".into());
        assert!(matches!(
            replica.library().import_envelope(&future),
            Err(DomainError::UnsupportedFeature(_))
        ));
    }
}
