use std::collections::{BTreeMap, BTreeSet};

use base64::{Engine as _, engine::general_purpose::STANDARD};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

use crate::{
    DomainError, DomainResult, PROTOCOL_VERSION, UpdateEnvelope, identity::validate_uuid_v7,
};

pub const OPERATION_PACK_FORMAT: &str = "researchpocket-operation-pack";
pub const OPERATION_PACK_VERSION: u8 = 1;
pub const OPERATION_PACK_FEATURE: &str = "operation-packs-v1";
pub const MAX_OPERATION_PACK_MEMBERS: usize = 1_000;
pub const MAX_OPERATION_PACK_BYTES: usize = 20 * 1024 * 1024;

/// Immutable collection of exact update-envelope JSON documents.
///
/// Member strings are standard-base64 encodings of the exact UTF-8 envelope
/// bytes. This lets a receiver recover and validate the original immutable
/// envelope without reserializing it.
#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct OperationPack {
    pub format: String,
    pub protocol_version: u8,
    pub pack_version: u8,
    pub required_features: Vec<String>,
    pub extensions: BTreeMap<String, serde_json::Value>,
    pub library_id: String,
    pub device_id: String,
    pub envelopes: Vec<String>,
}

/// Complete immutable artifact returned by both native and WASM codecs.
#[derive(Clone, Debug, Eq, PartialEq, Serialize)]
pub struct OperationPackArtifact {
    pub path: String,
    pub json: String,
    pub member_envelopes: Vec<String>,
}

/// Build one deterministic pack from two or more exact envelope JSON strings.
///
/// A single envelope intentionally remains in the legacy one-file form. Packs
/// are bounded to 1,000 members and 20 MiB of exact serialized pack JSON.
pub fn create_operation_pack(envelope_jsons: &[String]) -> DomainResult<OperationPackArtifact> {
    validate_member_count(envelope_jsons.len())?;
    let exact_member_bytes = envelope_jsons.iter().try_fold(0usize, |total, json| {
        total.checked_add(json.len()).ok_or_else(|| {
            DomainError::InvalidState("operation pack member size overflow".into())
        })
    })?;
    validate_pack_size(exact_member_bytes)?;

    let mut members = envelope_jsons
        .iter()
        .map(|json| validate_envelope_json(json).map(|envelope| (envelope, json.clone())))
        .collect::<DomainResult<Vec<_>>>()?;
    members.sort_by(|(left, _), (right, _)| left.sequence.cmp(&right.sequence));

    let first = members
        .first()
        .ok_or_else(|| DomainError::InvalidState("operation pack has no members".into()))?;
    validate_member_set(&members, &first.0.library_id, &first.0.device_id, true)?;
    let library_id = first.0.library_id.clone();
    let device_id = first.0.device_id.clone();

    let member_envelopes = members
        .into_iter()
        .map(|(_, json)| json)
        .collect::<Vec<_>>();
    let pack = OperationPack {
        format: OPERATION_PACK_FORMAT.to_owned(),
        protocol_version: PROTOCOL_VERSION,
        pack_version: OPERATION_PACK_VERSION,
        required_features: vec![OPERATION_PACK_FEATURE.to_owned()],
        extensions: BTreeMap::new(),
        library_id,
        device_id,
        envelopes: member_envelopes
            .iter()
            .map(|json| STANDARD.encode(json.as_bytes()))
            .collect(),
    };
    let json = serde_json::to_string(&pack)?;
    validate_pack_size(json.len())?;
    let path = pack_path(&pack.device_id, json.as_bytes());

    Ok(OperationPackArtifact {
        path,
        json,
        member_envelopes,
    })
}

/// Validate and unpack one immutable operation pack.
///
/// The path hash is checked against the exact supplied JSON bytes. Returned
/// member strings are the same UTF-8 bytes that were encoded in the pack.
pub fn unpack_operation_pack(
    path: &str,
    pack_json: &str,
) -> DomainResult<OperationPackArtifact> {
    validate_pack_size(pack_json.len())?;
    let pack: OperationPack = serde_json::from_str(pack_json)?;
    validate_pack_metadata(&pack)?;

    let expected_path = pack_path(&pack.device_id, pack_json.as_bytes());
    if path != expected_path {
        return Err(DomainError::Integrity {
            path: path.to_owned(),
            expected: expected_path,
            actual: path.to_owned(),
        });
    }

    validate_member_count(pack.envelopes.len())?;
    let mut members = Vec::with_capacity(pack.envelopes.len());
    for encoded in &pack.envelopes {
        let bytes = STANDARD.decode(encoded)?;
        if STANDARD.encode(&bytes) != *encoded {
            return Err(DomainError::InvalidState(
                "operation pack member is not canonical standard base64".into(),
            ));
        }
        let json = String::from_utf8(bytes).map_err(|_| {
            DomainError::InvalidState("operation pack member is not UTF-8 JSON".into())
        })?;
        let envelope = validate_envelope_json(&json)?;
        members.push((envelope, json));
    }
    validate_member_set(&members, &pack.library_id, &pack.device_id, true)?;

    Ok(OperationPackArtifact {
        path: path.to_owned(),
        json: pack_json.to_owned(),
        member_envelopes: members.into_iter().map(|(_, json)| json).collect(),
    })
}

fn validate_pack_metadata(pack: &OperationPack) -> DomainResult<()> {
    if pack.format != OPERATION_PACK_FORMAT {
        return Err(DomainError::InvalidState(format!(
            "unsupported operation pack format {:?}",
            pack.format
        )));
    }
    if pack.protocol_version != PROTOCOL_VERSION {
        return Err(DomainError::UnsupportedProtocol(pack.protocol_version));
    }
    if pack.pack_version != OPERATION_PACK_VERSION {
        return Err(DomainError::UnsupportedOperationPackVersion(
            pack.pack_version,
        ));
    }
    if pack.required_features != [OPERATION_PACK_FEATURE] {
        if let Some(feature) = pack
            .required_features
            .iter()
            .find(|feature| feature.as_str() != OPERATION_PACK_FEATURE)
        {
            return Err(DomainError::UnsupportedFeature(feature.clone()));
        }
        return Err(DomainError::InvalidState(
            "operation pack required_features must contain only operation-packs-v1".into(),
        ));
    }
    if !pack.extensions.is_empty() {
        return Err(DomainError::InvalidState(
            "operation pack extensions must be empty".into(),
        ));
    }
    validate_uuid_v7(&pack.library_id, "operation pack library ID")?;
    validate_uuid_v7(&pack.device_id, "operation pack device ID")?;
    Ok(())
}

fn validate_envelope_json(json: &str) -> DomainResult<UpdateEnvelope> {
    let envelope: UpdateEnvelope = serde_json::from_str(json)?;
    let path = envelope.path();
    envelope.validate_identity(&envelope.library_id, &path)?;
    let payload = envelope.verified_payload()?;
    if STANDARD.encode(payload) != envelope.payload {
        return Err(DomainError::InvalidState(format!(
            "envelope payload at {path} is not canonical standard base64"
        )));
    }
    Ok(envelope)
}

fn validate_member_set(
    members: &[(UpdateEnvelope, String)],
    expected_library_id: &str,
    expected_device_id: &str,
    require_sorted: bool,
) -> DomainResult<()> {
    validate_uuid_v7(expected_library_id, "operation pack library ID")?;
    validate_uuid_v7(expected_device_id, "operation pack device ID")?;

    let mut identities = BTreeSet::new();
    let mut previous_sequence: Option<&str> = None;
    for (envelope, _) in members {
        let path = envelope.path();
        envelope.validate_identity(expected_library_id, &path)?;
        if envelope.device_id != expected_device_id {
            return Err(DomainError::Integrity {
                path,
                expected: expected_device_id.to_owned(),
                actual: envelope.device_id.clone(),
            });
        }
        if require_sorted
            && previous_sequence.is_some_and(|previous| previous >= envelope.sequence.as_str())
        {
            return Err(DomainError::InvalidState(
                "operation pack members are not in strictly increasing device sequence order"
                    .into(),
            ));
        }
        previous_sequence = Some(&envelope.sequence);
        if !identities.insert(envelope.path()) {
            return Err(DomainError::InvalidState(format!(
                "duplicate operation pack member identity {}",
                envelope.path()
            )));
        }
    }
    Ok(())
}

fn validate_member_count(count: usize) -> DomainResult<()> {
    if !(2..=MAX_OPERATION_PACK_MEMBERS).contains(&count) {
        return Err(DomainError::InvalidState(format!(
            "operation packs require 2 to {MAX_OPERATION_PACK_MEMBERS} members, got {count}"
        )));
    }
    Ok(())
}

fn validate_pack_size(bytes: usize) -> DomainResult<()> {
    if bytes > MAX_OPERATION_PACK_BYTES {
        return Err(DomainError::InvalidState(format!(
            "operation pack exceeds the {MAX_OPERATION_PACK_BYTES}-byte limit"
        )));
    }
    Ok(())
}

fn pack_path(device_id: &str, json: &[u8]) -> String {
    format!("sync/v1/ops/packs/{device_id}/{}.json", sha256_hex(json))
}

fn sha256_hex(bytes: &[u8]) -> String {
    Sha256::digest(bytes)
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect()
}

#[cfg(test)]
mod tests {
    use loro::VersionVector;

    use super::*;

    const LIBRARY_ID: &str = "00000000-0000-7000-8000-000000000001";
    const DEVICE_ID: &str = "00000000-0000-7000-8000-000000000101";

    #[test]
    fn deterministic_round_trip_rejects_inner_tampering() {
        let frontier = VersionVector::default();
        let first = UpdateEnvelope::new(
            LIBRARY_ID,
            DEVICE_ID,
            1,
            &frontier,
            "2026-07-19T00:00:00Z",
            b"first-update",
        )
        .expect("first envelope");
        let second = UpdateEnvelope::new(
            LIBRARY_ID,
            DEVICE_ID,
            2,
            &frontier,
            "2026-07-19T00:00:01Z",
            b"second-update",
        )
        .expect("second envelope");
        let first_json = serde_json::to_string(&first).expect("serialize first envelope");
        let second_json = serde_json::to_string(&second).expect("serialize second envelope");

        let forward = create_operation_pack(&[first_json.clone(), second_json.clone()])
            .expect("build forward pack");
        let reverse =
            create_operation_pack(&[second_json, first_json]).expect("build reverse pack");
        assert_eq!(forward, reverse);
        assert_eq!(
            unpack_operation_pack(&forward.path, &forward.json).expect("unpack valid pack"),
            forward
        );

        let mut pack: OperationPack = serde_json::from_str(&forward.json).expect("parse pack");
        let mut member: serde_json::Value = serde_json::from_slice(
            &STANDARD.decode(&pack.envelopes[0]).expect("decode member"),
        )
        .expect("parse member");
        member["payload"] = serde_json::Value::String(STANDARD.encode(b"tampered-update"));
        pack.envelopes[0] =
            STANDARD.encode(serde_json::to_vec(&member).expect("serialize tampered member"));
        let tampered_json = serde_json::to_string(&pack).expect("serialize tampered pack");
        let tampered_path = pack_path(DEVICE_ID, tampered_json.as_bytes());
        assert!(unpack_operation_pack(&tampered_path, &tampered_json).is_err());
    }
}
