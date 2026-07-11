use std::collections::BTreeMap;

use base64::{Engine as _, engine::general_purpose::STANDARD};
use loro::VersionVector;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

use crate::{DomainError, DomainResult};

/// Immutable transport envelope. Git stores this value but never merges it.
#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
pub struct UpdateEnvelope {
    pub protocol_version: u8,
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
            protocol_version: 1,
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
        if self.protocol_version != 1 {
            return Err(DomainError::UnsupportedProtocol(self.protocol_version));
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

fn sha256_hex(bytes: &[u8]) -> String {
    Sha256::digest(bytes)
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect()
}
