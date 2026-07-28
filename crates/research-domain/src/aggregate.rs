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
pub const ITEM_OPS_PREFIX: &str = "sync/v2/ops/items/";
pub const ITEM_CHECKPOINTS_PREFIX: &str = "sync/v2/checkpoints/items/";

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum AggregateKind {
    Item,
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
    pub fn path(&self) -> String {
        format!(
            "{ITEM_OPS_PREFIX}{}/{}/{}.json",
            self.aggregate_id, self.device_id, self.sequence
        )
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
        if self.aggregate_kind != AggregateKind::Item {
            return Err(DomainError::InvalidState(
                "unsupported aggregate kind".into(),
            ));
        }
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
        if path != self.path() {
            return Err(DomainError::Integrity {
                path: path.to_owned(),
                expected: self.path(),
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
        envelope.validate(&envelope.path(), library_id, &self.item_id)?;
        Ok(envelope)
    }

    pub fn import_envelope(
        &self,
        path: &str,
        envelope: &AggregateEnvelope,
        expected_library_id: &str,
    ) -> DomainResult<bool> {
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
    Ok(AggregateMigration {
        genesis_json: serde_json::to_string(&genesis)?,
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
        assert!(envelope.path().contains(ITEM));
        assert!(
            !serde_json::to_string(&envelope)
                .unwrap()
                .contains(&"x".repeat(100))
        );

        let base = ItemAggregate::from_snapshot(ITEM, &base_snapshot, 22).expect("base");
        base.import_envelope(&envelope.path(), &envelope, LIBRARY)
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
