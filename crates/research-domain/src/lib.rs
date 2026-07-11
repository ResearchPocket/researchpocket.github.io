//! Executable V2 convergence spike.
//!
//! This crate intentionally contains no storage or Git transport code. Loro
//! resolves application conflicts; immutable envelopes only carry its updates.

mod document;
mod envelope;
mod genesis;
mod identity;
mod projection;

pub use document::{DomainError, DomainResult, ItemSeed, Library, validate_item_url};
pub use envelope::{DOMAIN_SCHEMA_VERSION, LORO_CODEC, PROTOCOL_VERSION, UpdateEnvelope};
pub use genesis::{LibraryGenesis, SYNC_FORMAT};
pub use projection::{
    CanonicalItem, CanonicalProjection, LifecycleRevision, LifecycleState, LifecycleView,
    ScalarRevision, ScalarView,
};

const ITEM_ID: &str = "0197f2b5-93d7-7ad4-8c67-21e98f0c7341";
const LIBRARY_ID: &str = "00000000-0000-7000-8000-000000000001";
const BASE_OPERATION_PREFIX: &str = "device-base/00000000000000000001";
const ALICE_TITLE_REVISION: &str = "device-alice/00000000000000000001";
const BOB_TITLE_REVISION: &str = "device-bob/00000000000000000001";
const ALICE_DELETE_REVISION: &str = "device-alice/00000000000000000002";
const ALICE_RESTORE_REVISION: &str = "device-alice/00000000000000000003";
const BOB_DELETE_REVISION: &str = "device-bob/00000000000000000002";
const BOB_TAG_DOT: &str = "device-bob/00000000000000000003";
const FINAL_TITLE_REVISION: &str = "device-merge/00000000000000000001";
const FINAL_RESTORE_REVISION: &str = "device-merge/00000000000000000002";

/// Fixed output shared by native and browser-WASM tests.
pub const GOLDEN_CANONICAL_JSON: &str = r#"{"schema_version":2,"items":{"0197f2b5-93d7-7ad4-8c67-21e98f0c7341":{"url":{"value":"https://example.com/original","winner":"device-base/00000000000000000001/url","heads":["device-base/00000000000000000001/url"],"revisions":{"device-base/00000000000000000001/url":{"parents":[],"value":"https://example.com/original"}}},"title":{"value":"Resolved title","winner":"device-merge/00000000000000000001","heads":["device-merge/00000000000000000001"],"revisions":{"device-alice/00000000000000000001":{"parents":["device-base/00000000000000000001/title"],"value":"Alice"},"device-base/00000000000000000001/title":{"parents":[],"value":"Original"},"device-bob/00000000000000000001":{"parents":["device-base/00000000000000000001/title"],"value":"Bob"},"device-merge/00000000000000000001":{"parents":["device-alice/00000000000000000001","device-bob/00000000000000000001"],"value":"Resolved title"}}},"excerpt":{"value":"An excerpt","winner":"device-base/00000000000000000001/excerpt","heads":["device-base/00000000000000000001/excerpt"],"revisions":{"device-base/00000000000000000001/excerpt":{"parents":[],"value":"An excerpt"}}},"favorite":{"value":false,"winner":"device-base/00000000000000000001/favorite","heads":["device-base/00000000000000000001/favorite"],"revisions":{"device-base/00000000000000000001/favorite":{"parents":[],"value":false}}},"language":{"value":"","winner":"device-base/00000000000000000001/language","heads":["device-base/00000000000000000001/language"],"revisions":{"device-base/00000000000000000001/language":{"parents":[],"value":""}}},"saved_at":{"value":1700000000,"winner":"device-base/00000000000000000001/saved_at","heads":["device-base/00000000000000000001/saved_at"],"revisions":{"device-base/00000000000000000001/saved_at":{"parents":[],"value":1700000000}}},"note":"A😀<A><B>B!","tags":[],"lifecycle":{"state":"active","generation":3,"heads":["device-merge/00000000000000000002"],"revisions":{"device-alice/00000000000000000002":{"generation":1,"parents":["device-base/00000000000000000001/lifecycle"],"state":"deleted"},"device-alice/00000000000000000003":{"generation":2,"parents":["device-alice/00000000000000000002"],"state":"active"},"device-base/00000000000000000001/lifecycle":{"generation":0,"parents":[],"state":"active"},"device-bob/00000000000000000002":{"generation":1,"parents":["device-base/00000000000000000001/lifecycle"],"state":"deleted"},"device-merge/00000000000000000002":{"generation":3,"parents":["device-alice/00000000000000000003","device-bob/00000000000000000002"],"state":"active"}}}}}}"#;

/// Run the complete deterministic convergence scenario used by both targets.
pub fn run_convergence_scenario() -> DomainResult<String> {
    let base = Library::with_peer_id_for_fixture(101)?;
    let base_before = base.version();
    base.create_item(
        &ItemSeed {
            item_id: ITEM_ID.to_owned(),
            url: "https://example.com/original".to_owned(),
            title: Some("Original".to_owned()),
            excerpt: Some("An excerpt".to_owned()),
            favorite: false,
            language: Some(String::new()),
            saved_at: 1_700_000_000,
            note: "A😀BCD".to_owned(),
            tags: vec!["Rust".to_owned()],
        },
        BASE_OPERATION_PREFIX,
    )?;
    let base_snapshot = base.export_snapshot()?;
    let base = Library::from_snapshot(&base_snapshot, 111)?;
    let base_envelope = base.export_envelope(
        &base_before,
        LIBRARY_ID,
        "00000000-0000-7000-8000-000000000101",
        1,
        "2026-07-10T00:00:00Z",
    )?;

    let mut legacy_envelope_json = serde_json::to_value(&base_envelope)?;
    let legacy_object = legacy_envelope_json
        .as_object_mut()
        .ok_or_else(|| DomainError::InvalidState("envelope JSON is not an object".into()))?;
    legacy_object.remove("domain_schema_version");
    legacy_object.remove("loro_codec");
    legacy_object.remove("required_features");
    legacy_object.remove("extensions");
    let legacy_envelope: UpdateEnvelope = serde_json::from_value(legacy_envelope_json)?;
    if legacy_envelope.domain_schema_version != DOMAIN_SCHEMA_VERSION
        || legacy_envelope.loro_codec != LORO_CODEC
        || !legacy_envelope.required_features.is_empty()
        || !legacy_envelope.extensions.is_empty()
    {
        return Err(DomainError::InvalidState(
            "pre-negotiation envelope defaults changed".into(),
        ));
    }

    let incompatible = Library::with_peer_id_for_fixture(112)?;
    let mut future_protocol = base_envelope.clone();
    future_protocol.protocol_version = PROTOCOL_VERSION + 1;
    if !matches!(
        incompatible.import_envelope(&future_protocol),
        Err(DomainError::UnsupportedProtocol(_))
    ) {
        return Err(DomainError::InvalidState(
            "future protocol version was not rejected".into(),
        ));
    }
    let mut future_schema = base_envelope.clone();
    future_schema.domain_schema_version = DOMAIN_SCHEMA_VERSION + 1;
    if !matches!(
        incompatible.import_envelope(&future_schema),
        Err(DomainError::UnsupportedDomainSchema(_))
    ) {
        return Err(DomainError::InvalidState(
            "future domain schema was not rejected".into(),
        ));
    }
    let mut future_codec = base_envelope.clone();
    future_codec.loro_codec = "future-codec".into();
    if !matches!(
        incompatible.import_envelope(&future_codec),
        Err(DomainError::UnsupportedCodec(_))
    ) {
        return Err(DomainError::InvalidState(
            "future Loro codec was not rejected".into(),
        ));
    }
    let mut future_feature = base_envelope.clone();
    future_feature.required_features = vec!["future-feature".into()];
    if !matches!(
        incompatible.import_envelope(&future_feature),
        Err(DomainError::UnsupportedFeature(_))
    ) {
        return Err(DomainError::InvalidState(
            "unknown required feature was not rejected".into(),
        ));
    }

    let alice = Library::with_peer_id_for_fixture(202)?;
    alice.import_envelope(&base_envelope)?;
    let alice_before = alice.version();
    alice.splice_note_utf16(ITEM_ID, 3, 0, "<A>")?;
    alice.splice_note_utf16(ITEM_ID, 7, 1, "")?;
    alice.write_title(ITEM_ID, ALICE_TITLE_REVISION, Some("Alice"))?;
    alice.remove_tag(ITEM_ID, "Rust")?;
    alice.transition_lifecycle(ITEM_ID, ALICE_DELETE_REVISION, LifecycleState::Deleted)?;
    alice.transition_lifecycle(ITEM_ID, ALICE_RESTORE_REVISION, LifecycleState::Active)?;
    let alice_envelope = alice.export_envelope(
        &alice_before,
        LIBRARY_ID,
        "00000000-0000-7000-8000-000000000202",
        1,
        "2026-07-10T00:00:01Z",
    )?;

    let bob = Library::with_peer_id_for_fixture(303)?;
    bob.import_envelope(&base_envelope)?;
    let bob_before = bob.version();
    bob.splice_note_utf16(ITEM_ID, 3, 0, "<B>")?;
    bob.splice_note_utf16(ITEM_ID, 8, 1, "!")?;
    bob.write_title(ITEM_ID, BOB_TITLE_REVISION, Some("Bob"))?;
    bob.add_tag(ITEM_ID, "Rust", BOB_TAG_DOT)?;
    bob.transition_lifecycle(ITEM_ID, BOB_DELETE_REVISION, LifecycleState::Deleted)?;
    let bob_envelope = bob.export_envelope(
        &bob_before,
        LIBRARY_ID,
        "00000000-0000-7000-8000-000000000303",
        1,
        "2026-07-10T00:00:02Z",
    )?;

    let merged = Library::with_peer_id_for_fixture(404)?;
    // Deliberately duplicate and reorder immutable envelopes.
    for envelope in [
        &bob_envelope,
        &alice_envelope,
        &base_envelope,
        &alice_envelope,
        &bob_envelope,
    ] {
        merged.import_envelope(envelope)?;
    }

    let intermediate = merged.canonical_projection()?;
    let intermediate_item = intermediate
        .items
        .get(ITEM_ID)
        .ok_or_else(|| DomainError::InvalidState("fixture item is missing".into()))?;
    if !intermediate_item.note.contains("<A>")
        || !intermediate_item.note.contains("<B>")
        || intermediate_item.note.contains('C')
        || intermediate_item.note.contains('D')
        || !intermediate_item.note.contains('!')
    {
        return Err(DomainError::InvalidState(format!(
            "character-level note edits were not retained: {}",
            intermediate_item.note
        )));
    }
    if intermediate_item.title.revisions.len() != 3
        || intermediate_item.title.value.as_deref() != Some("Bob")
    {
        return Err(DomainError::InvalidState(
            "concurrent scalar revisions were not retained deterministically".into(),
        ));
    }
    if intermediate_item.tags != ["Rust"] {
        return Err(DomainError::InvalidState(
            "an unseen concurrent tag add did not win".into(),
        ));
    }
    if intermediate_item.lifecycle.state != LifecycleState::Deleted {
        return Err(DomainError::InvalidState(
            "a partial restore resurrected a concurrently deleted item".into(),
        ));
    }

    let final_before = merged.version();
    merged.write_title(ITEM_ID, FINAL_TITLE_REVISION, Some("Resolved title"))?;
    merged.remove_tag(ITEM_ID, "Rust")?;
    merged.transition_lifecycle(ITEM_ID, FINAL_RESTORE_REVISION, LifecycleState::Active)?;
    let final_envelope = merged.export_envelope(
        &final_before,
        LIBRARY_ID,
        "00000000-0000-7000-8000-000000000404",
        1,
        "2026-07-10T00:00:03Z",
    )?;

    let envelopes = [base_envelope, alice_envelope, bob_envelope, final_envelope];
    let ordered = replay(&envelopes, [0, 1, 2, 3, 2, 0])?;
    let reversed = replay(&envelopes, [3, 2, 1, 0, 3, 1])?;
    if ordered != reversed {
        return Err(DomainError::InvalidState(
            "envelope order or duplication changed canonical state".into(),
        ));
    }

    let final_item = ordered
        .items
        .get(ITEM_ID)
        .ok_or_else(|| DomainError::InvalidState("fixture item is missing".into()))?;
    if final_item.title.value.as_deref() != Some("Resolved title")
        || final_item.title.revisions.len() != 4
        || final_item.url.value != "https://example.com/original"
        || final_item.excerpt.value.as_deref() != Some("An excerpt")
        || final_item.favorite.value
        || final_item.language.value.as_deref() != Some("")
        || final_item.saved_at.value != 1_700_000_000
        || !final_item.tags.is_empty()
        || final_item.lifecycle.state != LifecycleState::Active
        || final_item.lifecycle.generation != 3
    {
        return Err(DomainError::InvalidState(
            "final causal resolution did not match the contract".into(),
        ));
    }

    let json = serde_json::to_string(&ordered)?;
    if !GOLDEN_CANONICAL_JSON.is_empty() && json != GOLDEN_CANONICAL_JSON {
        return Err(DomainError::InvalidState(format!(
            "canonical output changed\nexpected: {GOLDEN_CANONICAL_JSON}\nactual:   {json}"
        )));
    }

    Ok(json)
}

fn replay<const N: usize>(
    envelopes: &[UpdateEnvelope; 4],
    order: [usize; N],
) -> DomainResult<CanonicalProjection> {
    let replica = Library::with_peer_id_for_fixture(900 + N as u64)?;
    for index in order {
        replica.import_envelope(&envelopes[index])?;
    }
    replica.canonical_projection()
}

/// Browser entry point. The browser executes the same Rust scenario as native tests.
#[cfg(target_arch = "wasm32")]
#[wasm_bindgen::prelude::wasm_bindgen]
pub fn run_wasm_convergence_scenario() -> Result<String, wasm_bindgen::JsValue> {
    run_convergence_scenario()
        .map_err(|error| wasm_bindgen::JsValue::from_str(&error.to_string()))
}
