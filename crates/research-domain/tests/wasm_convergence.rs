#![cfg(target_arch = "wasm32")]

use research_domain::{
    GOLDEN_CANONICAL_JSON, apply_mutation, apply_remote_envelopes, initialize_library,
    materialize_library, run_convergence_scenario,
};
use serde_json::{Value, json};
use wasm_bindgen_test::*;

wasm_bindgen_test_configure!(run_in_browser);

#[wasm_bindgen_test]
fn browser_wasm_executes_the_shared_convergence_scenario() {
    let actual = run_convergence_scenario().expect("WASM convergence scenario");
    assert_eq!(actual, GOLDEN_CANONICAL_JSON);
}

#[wasm_bindgen_test]
fn browser_snapshot_boundary_preserves_the_mutation_and_replay_contract() {
    const LIBRARY_ID: &str = "00000000-0000-7000-8000-000000000001";
    const ITEM_ID: &str = "00000000-0000-7000-8000-000000000003";

    let empty = initialize_library("18446744073709551614").expect("empty snapshot");
    let empty_projection: Value = serde_json::from_str(
        &materialize_library(&empty, "1").expect("materialize empty snapshot"),
    )
    .expect("empty projection JSON");
    assert_eq!(empty_projection, json!({"schema_version": 2, "items": []}));

    let created = mutation(
        &empty,
        "1",
        json!({
            "type": "create",
            "item_id": ITEM_ID,
            "url": "https://example.com",
            "title": "",
            "excerpt": null,
            "favorite": true,
            "language": null,
            "saved_at": 1_700_000_000,
            "note": "hello",
            "tags": ["z", "a", "a"]
        }),
    );
    let note_advanced = mutation(
        created["snapshot"].as_str().expect("created snapshot"),
        "2",
        json!({
            "type": "edit",
            "item_id": ITEM_ID,
            "note": {"type": "set", "value": "hello from sync"},
            "expected_note": "hello"
        }),
    );
    assert!(
        apply_mutation(
            note_advanced["snapshot"]
                .as_str()
                .expect("advanced-note snapshot"),
            "18446744073709551614",
            LIBRARY_ID,
            "00000000-0000-7000-8000-000000000002",
            "3",
            "2026-07-11T00:00:00Z",
            &json!({
                "type": "edit",
                "item_id": ITEM_ID,
                "note": {"type": "set", "value": "stale replacement"},
                "expected_note": "hello"
            })
            .to_string(),
        )
        .is_err()
    );
    let edited = mutation(
        created["snapshot"].as_str().expect("created snapshot"),
        "2",
        json!({
            "type": "edit",
            "item_id": ITEM_ID,
            "title": {"type": "clear"},
            "note": {"type": "clear"},
            "add_tags": ["b"],
            "remove_tags": ["z"]
        }),
    );
    let deleted = mutation(
        edited["snapshot"].as_str().expect("edited snapshot"),
        "3",
        json!({"type": "delete", "item_id": ITEM_ID}),
    );
    let restored = mutation(
        deleted["snapshot"].as_str().expect("deleted snapshot"),
        "4",
        json!({"type": "restore", "item_id": ITEM_ID}),
    );

    let expected_projection = json!({
        "schema_version": 2,
        "items": [{
            "id": ITEM_ID,
            "url": "https://example.com",
            "title": null,
            "excerpt": null,
            "note": null,
            "favorite": true,
            "language": null,
            "saved_at": 1_700_000_000,
            "tags": ["a", "b"],
            "state": "active"
        }]
    });
    assert_eq!(restored["projection"], expected_projection);

    let replica = initialize_library("42").expect("replica snapshot");
    let child_only: Value = serde_json::from_str(
        &apply_remote_envelopes(
            &replica,
            "42",
            LIBRARY_ID,
            &json!([edited["envelope"]]).to_string(),
        )
        .expect("defer child without its predecessor"),
    )
    .expect("deferred result JSON");
    assert_eq!(child_only["pending_indices"], json!([0]));
    assert_eq!(
        child_only["projection"],
        json!({"schema_version": 2, "items": []})
    );

    let resolved: Value = serde_json::from_str(
        &apply_remote_envelopes(
            child_only["snapshot"].as_str().expect("deferred snapshot"),
            "42",
            LIBRARY_ID,
            &json!([created["envelope"], edited["envelope"]]).to_string(),
        )
        .expect("resolve child after predecessor arrives"),
    )
    .expect("resolved result JSON");
    assert_eq!(resolved["pending_indices"], json!([]));
    assert_eq!(resolved["projection"], edited["projection"]);

    let created_envelope = created["envelope"].as_str().expect("created envelope");
    let exact_duplicate: Value = serde_json::from_str(
        &apply_remote_envelopes(
            &replica,
            "42",
            LIBRARY_ID,
            &json!([created_envelope, created_envelope]).to_string(),
        )
        .expect("accept exact duplicate identity"),
    )
    .expect("exact duplicate result JSON");
    assert_eq!(exact_duplicate["pending_indices"], json!([]));
    assert_eq!(exact_duplicate["projection"], created["projection"]);

    let mut invalid_timestamp: Value =
        serde_json::from_str(created_envelope).expect("created envelope JSON");
    invalid_timestamp["created_at"] = json!("not-rfc3339");
    assert!(
        apply_remote_envelopes(
            &replica,
            "42",
            LIBRARY_ID,
            &json!([invalid_timestamp.to_string()]).to_string(),
        )
        .is_err()
    );

    let mut identity_collision: Value =
        serde_json::from_str(created_envelope).expect("created envelope JSON");
    identity_collision["created_at"] = json!("2026-07-11T00:00:01Z");
    assert!(
        apply_remote_envelopes(
            &replica,
            "42",
            LIBRARY_ID,
            &json!([created_envelope, identity_collision.to_string()]).to_string(),
        )
        .is_err()
    );

    let reversed_envelopes = json!([
        restored["envelope"],
        deleted["envelope"],
        edited["envelope"],
        created["envelope"]
    ]);
    let replayed: Value = serde_json::from_str(
        &apply_remote_envelopes(&replica, "42", LIBRARY_ID, &reversed_envelopes.to_string())
            .expect("reverse remote replay"),
    )
    .expect("remote result JSON");
    assert_eq!(replayed["pending_indices"], json!([]));
    assert_eq!(replayed["projection"], expected_projection);
}

fn mutation(snapshot: &str, sequence: &str, mutation: Value) -> Value {
    serde_json::from_str(
        &apply_mutation(
            snapshot,
            "18446744073709551614",
            "00000000-0000-7000-8000-000000000001",
            "00000000-0000-7000-8000-000000000002",
            sequence,
            "2026-07-11T00:00:00Z",
            &mutation.to_string(),
        )
        .expect("local browser mutation"),
    )
    .expect("local mutation result JSON")
}
