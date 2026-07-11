use std::collections::BTreeMap;

use base64::{Engine as _, engine::general_purpose::STANDARD};
use loro::VersionVector;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

use crate::{DomainError, DomainResult};

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
    ) -> Self {
        let causal_frontier = causal_frontier
            .iter()
            .map(|(peer, counter)| (peer.to_string(), *counter))
            .collect();
        Self {
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
        }
    }

    pub fn path(&self) -> String {
        format!("sync/v1/ops/{}/{}.json", self.device_id, self.sequence)
    }

    pub(crate) fn verified_payload(&self) -> DomainResult<Vec<u8>> {
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
