use std::collections::BTreeMap;

use base64::{Engine as _, engine::general_purpose::STANDARD};
use chrono::{DateTime, FixedOffset};
use loro::VersionVector;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

use crate::{DomainError, DomainResult, identity::validate_uuid_v7};

pub const PROTOCOL_VERSION: u8 = 1;
pub const DOMAIN_SCHEMA_VERSION: u16 = 2;
pub const LORO_CODEC: &str = "1.13.6";

/// Immutable transport envelope. Git stores this value but never merges it.
#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct UpdateEnvelope {
    pub protocol_version: u8,
    #[serde(default = "default_domain_schema_version")]
    pub domain_schema_version: u16,
    #[serde(default = "default_loro_codec")]
    pub loro_codec: String,
    #[serde(default)]
    pub required_features: Vec<String>,
    #[serde(default)]
    pub extensions: BTreeMap<String, serde_json::Value>,
    pub library_id: String,
    pub device_id: String,
    /// Fixed-width decimal avoids JavaScript's 64-bit integer limit.
    pub sequence: String,
    /// Loro peer IDs are strings because they are unsigned 64-bit values.
    pub causal_frontier: BTreeMap<String, i32>,
    pub created_at: String,
    pub payload: String,
    pub payload_sha256: String,
}

impl UpdateEnvelope {
    pub(crate) fn new(
        library_id: &str,
        device_id: &str,
        sequence: u64,
        causal_frontier: &VersionVector,
        created_at: &str,
        update: &[u8],
    ) -> DomainResult<Self> {
        let causal_frontier = causal_frontier
            .iter()
            .map(|(peer, counter)| (peer.to_string(), *counter))
            .collect();
        let envelope = Self {
            protocol_version: PROTOCOL_VERSION,
            domain_schema_version: DOMAIN_SCHEMA_VERSION,
            loro_codec: LORO_CODEC.to_owned(),
            required_features: Vec::new(),
            extensions: BTreeMap::new(),
            library_id: library_id.to_owned(),
            device_id: device_id.to_owned(),
            sequence: format!("{sequence:020}"),
            causal_frontier,
            // Time is caller-supplied audit metadata, never merge input.
            created_at: created_at.to_owned(),
            payload: STANDARD.encode(update),
            payload_sha256: sha256_hex(update),
        };
        envelope.validate_identity(library_id, &envelope.path())?;
        Ok(envelope)
    }

    pub fn path(&self) -> String {
        format!("sync/v1/ops/{}/{}.json", self.device_id, self.sequence)
    }

    pub fn validate_identity(&self, expected_library_id: &str, path: &str) -> DomainResult<()> {
        validate_uuid_v7(&self.library_id, "library ID")?;
        validate_uuid_v7(&self.device_id, "device ID")?;
        validate_uuid_v7(expected_library_id, "expected library ID")?;
        if self.library_id != expected_library_id {
            return Err(DomainError::Integrity {
                path: path.to_owned(),
                expected: expected_library_id.to_owned(),
                actual: self.library_id.clone(),
            });
        }
        let valid_sequence = self.sequence.len() == 20
            && self.sequence.bytes().all(|byte| byte.is_ascii_digit())
            && self.sequence != "00000000000000000000"
            && self.sequence.parse::<u64>().is_ok();
        if !valid_sequence {
            return Err(DomainError::InvalidState(format!(
                "batch sequence {:?} is not a nonzero fixed-width decimal",
                self.sequence
            )));
        }
        let expected_path = self.path();
        if path != expected_path {
            return Err(DomainError::Integrity {
                path: path.to_owned(),
                expected: expected_path,
                actual: path.to_owned(),
            });
        }
        validate_timestamp(&self.created_at)?;
        for (peer, counter) in &self.causal_frontier {
            if peer.parse::<u64>().is_err() || *counter < 0 {
                return Err(DomainError::InvalidState(format!(
                    "invalid causal frontier entry {peer:?}"
                )));
            }
        }
        Ok(())
    }

    pub(crate) fn verified_payload(&self) -> DomainResult<Vec<u8>> {
        self.validate_identity(&self.library_id, &self.path())?;
        if self.protocol_version != PROTOCOL_VERSION {
            return Err(DomainError::UnsupportedProtocol(self.protocol_version));
        }
        if self.domain_schema_version != DOMAIN_SCHEMA_VERSION {
            return Err(DomainError::UnsupportedDomainSchema(
                self.domain_schema_version,
            ));
        }
        if self.loro_codec != LORO_CODEC {
            return Err(DomainError::UnsupportedCodec(self.loro_codec.clone()));
        }
        if let Some(feature) = self.required_features.first() {
            return Err(DomainError::UnsupportedFeature(feature.clone()));
        }
        let payload = STANDARD.decode(&self.payload)?;
        let actual = sha256_hex(&payload);
        if actual != self.payload_sha256 {
            return Err(DomainError::Integrity {
                path: self.path(),
                expected: self.payload_sha256.clone(),
                actual,
            });
        }
        Ok(payload)
    }
}

fn validate_timestamp(value: &str) -> DomainResult<()> {
    let parsed: DateTime<FixedOffset> = DateTime::parse_from_rfc3339(value)
        .map_err(|_| DomainError::InvalidState("invalid operation creation time".into()))?;
    if parsed.offset().local_minus_utc() != 0 {
        return Err(DomainError::InvalidState(
            "operation creation time is not in UTC".into(),
        ));
    }
    Ok(())
}

const fn default_domain_schema_version() -> u16 {
    DOMAIN_SCHEMA_VERSION
}

fn default_loro_codec() -> String {
    LORO_CODEC.to_owned()
}

fn sha256_hex(bytes: &[u8]) -> String {
    Sha256::digest(bytes)
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect()
}
