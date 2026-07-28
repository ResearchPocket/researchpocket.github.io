use std::collections::BTreeMap;

use base64::{Engine as _, engine::general_purpose::STANDARD};
use chrono::{DateTime, FixedOffset};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

use crate::{
    DOMAIN_SCHEMA_VERSION, DomainError, DomainResult, LORO_CODEC, Library, PROTOCOL_VERSION,
    identity::validate_uuid_v7,
};

pub const CHECKPOINTS_PREFIX: &str = "sync/v1/checkpoints/";
pub const MAX_CHECKPOINT_BYTES: usize = 64 * 1024 * 1024;

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct CoverageInterval {
    pub start: String,
    pub end: String,
}

impl CoverageInterval {
    pub fn new(start: u64, end: u64) -> DomainResult<Self> {
        if start == 0 || start > end {
            return Err(DomainError::InvalidState(
                "checkpoint coverage interval must be nonzero and ordered".into(),
            ));
        }
        Ok(Self {
            start: format!("{start:020}"),
            end: format!("{end:020}"),
        })
    }

    pub fn contains(&self, sequence: &str) -> bool {
        self.start.as_str() <= sequence && sequence <= self.end.as_str()
    }

    fn bounds(&self) -> DomainResult<(u64, u64)> {
        let start = parse_sequence(&self.start)?;
        let end = parse_sequence(&self.end)?;
        if start > end {
            return Err(DomainError::InvalidState(
                "checkpoint coverage interval is reversed".into(),
            ));
        }
        Ok((start, end))
    }
}

pub type CheckpointCoverage = BTreeMap<String, Vec<CoverageInterval>>;

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Checkpoint {
    pub protocol_version: u8,
    pub domain_schema_version: u16,
    pub loro_codec: String,
    #[serde(default)]
    pub required_features: Vec<String>,
    #[serde(default)]
    pub extensions: BTreeMap<String, serde_json::Value>,
    pub library_id: String,
    pub checkpoint_id: String,
    pub created_at: String,
    pub frontier: BTreeMap<String, i32>,
    pub coverage: CheckpointCoverage,
    pub batch_count: u64,
    pub payload: String,
    pub payload_sha256: String,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
pub struct CheckpointArtifact {
    pub path: String,
    pub json: String,
    pub checkpoint_id: String,
    pub created_at: String,
    pub batch_count: u64,
    pub coverage: CheckpointCoverage,
    pub snapshot_base64: String,
}

pub fn create_checkpoint(
    snapshot: &[u8],
    library_id: &str,
    created_at: &str,
    coverage: CheckpointCoverage,
) -> DomainResult<CheckpointArtifact> {
    validate_uuid_v7(library_id, "checkpoint library ID")?;
    validate_timestamp(created_at)?;
    let library = Library::from_snapshot(snapshot, validation_peer_id())?;
    let frontier = frontier(&library);
    let batch_count = validate_coverage(&coverage)?;
    let checkpoint_id = sha256_hex(snapshot);
    let checkpoint = Checkpoint {
        protocol_version: PROTOCOL_VERSION,
        domain_schema_version: DOMAIN_SCHEMA_VERSION,
        loro_codec: LORO_CODEC.to_owned(),
        required_features: Vec::new(),
        extensions: BTreeMap::new(),
        library_id: library_id.to_owned(),
        checkpoint_id: checkpoint_id.clone(),
        created_at: created_at.to_owned(),
        frontier,
        coverage: coverage.clone(),
        batch_count,
        payload: STANDARD.encode(snapshot),
        payload_sha256: checkpoint_id.clone(),
    };
    let json = serde_json::to_string(&checkpoint)?;
    validate_size(json.len())?;
    Ok(CheckpointArtifact {
        path: checkpoint_path(&checkpoint_id),
        json,
        checkpoint_id,
        created_at: created_at.to_owned(),
        batch_count,
        coverage,
        snapshot_base64: checkpoint.payload,
    })
}

pub fn validate_checkpoint(
    path: &str,
    json: &str,
    expected_library_id: &str,
) -> DomainResult<CheckpointArtifact> {
    validate_size(json.len())?;
    validate_uuid_v7(expected_library_id, "expected checkpoint library ID")?;
    let checkpoint: Checkpoint = serde_json::from_str(json)?;
    if checkpoint.protocol_version != PROTOCOL_VERSION {
        return Err(DomainError::UnsupportedProtocol(
            checkpoint.protocol_version,
        ));
    }
    if checkpoint.domain_schema_version > DOMAIN_SCHEMA_VERSION {
        return Err(DomainError::UnsupportedDomainSchema(
            checkpoint.domain_schema_version,
        ));
    }
    if checkpoint.loro_codec != LORO_CODEC {
        return Err(DomainError::UnsupportedCodec(checkpoint.loro_codec.clone()));
    }
    if let Some(feature) = checkpoint.required_features.first() {
        return Err(DomainError::UnsupportedFeature(feature.clone()));
    }
    if !checkpoint.extensions.is_empty() {
        return Err(DomainError::InvalidState(
            "checkpoint extensions must be empty".into(),
        ));
    }
    validate_uuid_v7(&checkpoint.library_id, "checkpoint library ID")?;
    if checkpoint.library_id != expected_library_id {
        return Err(DomainError::Integrity {
            path: path.to_owned(),
            expected: expected_library_id.to_owned(),
            actual: checkpoint.library_id,
        });
    }
    validate_timestamp(&checkpoint.created_at)?;
    let expected_path = checkpoint_path(&checkpoint.checkpoint_id);
    if path != expected_path {
        return Err(DomainError::Integrity {
            path: path.to_owned(),
            expected: expected_path,
            actual: path.to_owned(),
        });
    }
    if checkpoint.payload_sha256 != checkpoint.checkpoint_id {
        return Err(DomainError::Integrity {
            path: path.to_owned(),
            expected: checkpoint.checkpoint_id,
            actual: checkpoint.payload_sha256,
        });
    }
    let snapshot = STANDARD.decode(&checkpoint.payload)?;
    if STANDARD.encode(&snapshot) != checkpoint.payload {
        return Err(DomainError::InvalidState(
            "checkpoint payload is not canonical standard base64".into(),
        ));
    }
    let actual_hash = sha256_hex(&snapshot);
    if actual_hash != checkpoint.payload_sha256 {
        return Err(DomainError::Integrity {
            path: path.to_owned(),
            expected: checkpoint.payload_sha256,
            actual: actual_hash,
        });
    }
    let library = Library::from_snapshot(&snapshot, validation_peer_id())?;
    let actual_frontier = frontier(&library);
    validate_frontier(&checkpoint.frontier)?;
    if checkpoint.frontier != actual_frontier {
        return Err(DomainError::InvalidState(
            "checkpoint frontier does not match its snapshot".into(),
        ));
    }
    let batch_count = validate_coverage(&checkpoint.coverage)?;
    if checkpoint.batch_count != batch_count {
        return Err(DomainError::InvalidState(
            "checkpoint batch count does not match its coverage".into(),
        ));
    }
    Ok(CheckpointArtifact {
        path: path.to_owned(),
        json: json.to_owned(),
        checkpoint_id: checkpoint.checkpoint_id,
        created_at: checkpoint.created_at,
        batch_count,
        coverage: checkpoint.coverage,
        snapshot_base64: checkpoint.payload,
    })
}

pub fn coverage_contains(
    coverage: &CheckpointCoverage,
    device_id: &str,
    sequence: &str,
) -> bool {
    coverage
        .get(device_id)
        .is_some_and(|intervals| intervals.iter().any(|interval| interval.contains(sequence)))
}

fn validate_coverage(coverage: &CheckpointCoverage) -> DomainResult<u64> {
    let mut batch_count = 0_u64;
    for (device_id, intervals) in coverage {
        validate_uuid_v7(device_id, "checkpoint coverage device ID")?;
        let mut previous_end = 0_u64;
        for interval in intervals {
            let (start, end) = interval.bounds()?;
            if start <= previous_end {
                return Err(DomainError::InvalidState(
                    "checkpoint coverage intervals overlap or are unsorted".into(),
                ));
            }
            let count = end
                .checked_sub(start)
                .and_then(|distance| distance.checked_add(1))
                .ok_or_else(|| {
                    DomainError::InvalidState("checkpoint coverage size overflow".into())
                })?;
            batch_count = batch_count.checked_add(count).ok_or_else(|| {
                DomainError::InvalidState("checkpoint batch count overflow".into())
            })?;
            previous_end = end;
        }
    }
    Ok(batch_count)
}

fn validate_frontier(frontier: &BTreeMap<String, i32>) -> DomainResult<()> {
    for (peer, counter) in frontier {
        if peer.parse::<u64>().is_err() || *counter < 0 {
            return Err(DomainError::InvalidState(
                "checkpoint frontier contains an invalid entry".into(),
            ));
        }
    }
    Ok(())
}

fn frontier(library: &Library) -> BTreeMap<String, i32> {
    library
        .version()
        .iter()
        .map(|(peer, counter)| (peer.to_string(), *counter))
        .collect()
}

fn parse_sequence(value: &str) -> DomainResult<u64> {
    if value.len() != 20
        || value == "00000000000000000000"
        || !value.bytes().all(|byte| byte.is_ascii_digit())
    {
        return Err(DomainError::InvalidState(
            "checkpoint sequence is not a nonzero fixed-width decimal".into(),
        ));
    }
    value
        .parse::<u64>()
        .map_err(|_| DomainError::InvalidState("checkpoint sequence is out of range".into()))
}

fn validate_timestamp(value: &str) -> DomainResult<()> {
    let parsed: DateTime<FixedOffset> = DateTime::parse_from_rfc3339(value)
        .map_err(|_| DomainError::InvalidState("invalid checkpoint creation time".into()))?;
    if parsed.offset().local_minus_utc() != 0 {
        return Err(DomainError::InvalidState(
            "checkpoint creation time is not in UTC".into(),
        ));
    }
    Ok(())
}

fn checkpoint_path(checkpoint_id: &str) -> String {
    format!("{CHECKPOINTS_PREFIX}{checkpoint_id}.json")
}

fn validate_size(bytes: usize) -> DomainResult<()> {
    if bytes > MAX_CHECKPOINT_BYTES {
        return Err(DomainError::InvalidState(format!(
            "checkpoint exceeds the {MAX_CHECKPOINT_BYTES}-byte limit"
        )));
    }
    Ok(())
}

fn validation_peer_id() -> u64 {
    u64::MAX - 1
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
    use crate::ItemSeed;

    const LIBRARY_ID: &str = "00000000-0000-7000-8000-000000000001";
    const DEVICE_ID: &str = "00000000-0000-7000-8000-000000000101";
    const ITEM_ID: &str = "00000000-0000-7000-8000-000000000201";

    fn artifact() -> CheckpointArtifact {
        let library = Library::with_peer_id_for_fixture(101).expect("library");
        library
            .create_item(
                &ItemSeed {
                    item_id: ITEM_ID.into(),
                    url: "https://example.com".into(),
                    title: None,
                    excerpt: None,
                    favorite: false,
                    language: None,
                    saved_at: 1_700_000_000,
                    note: String::new(),
                    tags: Vec::new(),
                },
                "device/00000000000000000001",
            )
            .expect("item");
        let coverage = BTreeMap::from([(
            DEVICE_ID.to_owned(),
            vec![CoverageInterval::new(1, 3).expect("coverage")],
        )]);
        create_checkpoint(
            &library.export_snapshot().expect("snapshot"),
            LIBRARY_ID,
            "2026-07-28T00:00:00Z",
            coverage,
        )
        .expect("checkpoint")
    }

    #[test]
    fn checkpoint_round_trip_validates_snapshot_and_exact_coverage() {
        let artifact = artifact();
        let validated =
            validate_checkpoint(&artifact.path, &artifact.json, LIBRARY_ID).expect("validate");
        assert_eq!(validated.checkpoint_id, artifact.checkpoint_id);
        assert_eq!(validated.batch_count, 3);
        assert!(coverage_contains(
            &validated.coverage,
            DEVICE_ID,
            "00000000000000000002"
        ));
        assert!(!coverage_contains(
            &validated.coverage,
            DEVICE_ID,
            "00000000000000000004"
        ));
    }

    #[test]
    fn checkpoint_rejects_tampered_snapshot_and_coverage() {
        let artifact = artifact();
        let mut checkpoint: Checkpoint =
            serde_json::from_str(&artifact.json).expect("checkpoint JSON");
        checkpoint.payload.push('A');
        let tampered = serde_json::to_string(&checkpoint).expect("tampered JSON");
        assert!(validate_checkpoint(&artifact.path, &tampered, LIBRARY_ID).is_err());

        let mut checkpoint: Checkpoint =
            serde_json::from_str(&artifact.json).expect("checkpoint JSON");
        checkpoint.batch_count += 1;
        let tampered = serde_json::to_string(&checkpoint).expect("tampered JSON");
        assert!(validate_checkpoint(&artifact.path, &tampered, LIBRARY_ID).is_err());
    }
}
