//! Executable V2 convergence spike.
//!
//! This crate intentionally contains no storage or Git transport code. Loro
//! resolves application conflicts; immutable envelopes only carry its updates.

mod document;
mod envelope;
mod projection;

pub use document::{DomainError, DomainResult, Library};
pub use envelope::UpdateEnvelope;
pub use projection::{
    CanonicalItem, CanonicalProjection, LifecycleRevision, LifecycleState, LifecycleView,
    ScalarRevision, ScalarView,
};

const ITEM_ID: &str = "0197f2b5-93d7-7ad4-8c67-21e98f0c7341";
const BASE_TITLE_REVISION: &str = "device-base/00000000000000000001";
const BASE_TAG_DOT: &str = "device-base/00000000000000000002";
const BASE_LIFECYCLE_REVISION: &str = "device-base/00000000000000000003";
const ALICE_TITLE_REVISION: &str = "device-alice/00000000000000000001";
const BOB_TITLE_REVISION: &str = "device-bob/00000000000000000001";
const ALICE_DELETE_REVISION: &str = "device-alice/00000000000000000002";
const ALICE_RESTORE_REVISION: &str = "device-alice/00000000000000000003";
const BOB_DELETE_REVISION: &str = "device-bob/00000000000000000002";
const BOB_TAG_DOT: &str = "device-bob/00000000000000000003";
const FINAL_TITLE_REVISION: &str = "device-merge/00000000000000000001";
const FINAL_RESTORE_REVISION: &str = "device-merge/00000000000000000002";

/// Fixed output shared by native and browser-WASM tests.
pub const GOLDEN_CANONICAL_JSON: &str = r#"{"schema_version":1,"items":{"0197f2b5-93d7-7ad4-8c67-21e98f0c7341":{"title":{"value":"Resolved title","winner":"device-merge/00000000000000000001","heads":["device-merge/00000000000000000001"],"revisions":{"device-alice/00000000000000000001":{"parents":["device-base/00000000000000000001"],"value":"Alice"},"device-base/00000000000000000001":{"parents":[],"value":"Original"},"device-bob/00000000000000000001":{"parents":["device-base/00000000000000000001"],"value":"Bob"},"device-merge/00000000000000000001":{"parents":["device-alice/00000000000000000001","device-bob/00000000000000000001"],"value":"Resolved title"}}},"note":"A😀<A><B>B!","tags":[],"lifecycle":{"state":"active","generation":3,"heads":["device-merge/00000000000000000002"],"revisions":{"device-alice/00000000000000000002":{"generation":1,"parents":["device-base/00000000000000000003"],"state":"deleted"},"device-alice/00000000000000000003":{"generation":2,"parents":["device-alice/00000000000000000002"],"state":"active"},"device-base/00000000000000000003":{"generation":0,"parents":[],"state":"active"},"device-bob/00000000000000000002":{"generation":1,"parents":["device-base/00000000000000000003"],"state":"deleted"},"device-merge/00000000000000000002":{"generation":3,"parents":["device-alice/00000000000000000003","device-bob/00000000000000000002"],"state":"active"}}}}}}"#;

/// Run the complete deterministic convergence scenario used by both targets.
pub fn run_convergence_scenario() -> DomainResult<String> {
    let base = Library::with_peer_id_for_fixture(101)?;
    let base_before = base.version();
    base.initialize_item(
        ITEM_ID,
        "A😀BCD",
        BASE_TITLE_REVISION,
        "Original",
        BASE_LIFECYCLE_REVISION,
    )?;
    base.add_tag(ITEM_ID, "rust", BASE_TAG_DOT)?;
    let base_envelope = base.export_envelope(
        &base_before,
        "library-fixture",
        "00000000-0000-7000-8000-000000000101",
        1,
    )?;

    let alice = Library::with_peer_id_for_fixture(202)?;
    alice.import_envelope(&base_envelope)?;
    let alice_before = alice.version();
    alice.splice_note_utf16(ITEM_ID, 3, 0, "<A>")?;
    alice.splice_note_utf16(ITEM_ID, 7, 1, "")?;
    alice.write_scalar(ITEM_ID, "title", ALICE_TITLE_REVISION, "Alice")?;
    alice.remove_tag(ITEM_ID, "rust")?;
    alice.transition_lifecycle(ITEM_ID, ALICE_DELETE_REVISION, LifecycleState::Deleted)?;
    alice.transition_lifecycle(ITEM_ID, ALICE_RESTORE_REVISION, LifecycleState::Active)?;
    let alice_envelope = alice.export_envelope(
        &alice_before,
        "library-fixture",
        "00000000-0000-7000-8000-000000000202",
        1,
    )?;

    let bob = Library::with_peer_id_for_fixture(303)?;
    bob.import_envelope(&base_envelope)?;
    let bob_before = bob.version();
    bob.splice_note_utf16(ITEM_ID, 3, 0, "<B>")?;
    bob.splice_note_utf16(ITEM_ID, 8, 1, "!")?;
    bob.write_scalar(ITEM_ID, "title", BOB_TITLE_REVISION, "Bob")?;
    bob.add_tag(ITEM_ID, "rust", BOB_TAG_DOT)?;
    bob.transition_lifecycle(ITEM_ID, BOB_DELETE_REVISION, LifecycleState::Deleted)?;
    let bob_envelope = bob.export_envelope(
        &bob_before,
        "library-fixture",
        "00000000-0000-7000-8000-000000000303",
        1,
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
    if intermediate_item.title.revisions.len() != 3 || intermediate_item.title.value != "Bob" {
        return Err(DomainError::InvalidState(
            "concurrent scalar revisions were not retained deterministically".into(),
        ));
    }
    if intermediate_item.tags != ["rust"] {
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
    merged.write_scalar(ITEM_ID, "title", FINAL_TITLE_REVISION, "Resolved title")?;
    merged.remove_tag(ITEM_ID, "rust")?;
    merged.transition_lifecycle(ITEM_ID, FINAL_RESTORE_REVISION, LifecycleState::Active)?;
    let final_envelope = merged.export_envelope(
        &final_before,
        "library-fixture",
        "00000000-0000-7000-8000-000000000404",
        1,
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
    if final_item.title.value != "Resolved title"
        || final_item.title.revisions.len() != 4
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
