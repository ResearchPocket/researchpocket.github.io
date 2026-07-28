use std::collections::BTreeMap;

use base64::{Engine as _, engine::general_purpose::STANDARD};
use research_domain::{
    CheckpointCoverage, CoverageInterval, ItemSeed, Library, create_captured_document,
    create_checkpoint, validate_checkpoint,
};

const LIBRARY_ID: &str = "00000000-0000-7000-8000-000000000001";
const DEVICE_ID: &str = "00000000-0000-7000-8000-000000000002";

#[test]
fn thousand_item_checkpoint_excludes_four_mib_captured_content_and_restores() {
    let captured = create_captured_document(
        &"x".repeat(4 * 1024 * 1024),
        "firecrawl",
        "https://example.com/scaled-fixture",
        "2026-07-28T00:00:00Z",
    )
    .expect("captured fixture");
    let library = Library::with_peer_id_for_fixture(91).expect("library");
    for index in 1..=1_000_u64 {
        let item_id = format!("01900000-0000-7000-8000-{index:012x}");
        let prefix = format!("{DEVICE_ID}/{index:020}/fixture/{item_id}");
        library
            .create_item(
                &ItemSeed {
                    item_id: item_id.clone(),
                    url: format!("https://example.com/items/{index}"),
                    title: Some(format!("Fixture {index}")),
                    excerpt: None,
                    favorite: false,
                    language: Some("en".into()),
                    saved_at: 1_700_000_000 + index as i64,
                    note: String::new(),
                    tags: vec!["fixture".into()],
                },
                &prefix,
            )
            .expect("seed item");
        library
            .write_captured_document(
                &item_id,
                &format!("{prefix}/captured-document"),
                Some(&captured.reference),
            )
            .expect("reference content");
    }

    let snapshot = library.export_snapshot().expect("snapshot");
    let coverage = CheckpointCoverage::from([(
        DEVICE_ID.to_owned(),
        vec![CoverageInterval::new(1, 100).expect("coverage")],
    )]);
    let checkpoint = create_checkpoint(&snapshot, LIBRARY_ID, "2026-07-28T00:00:01Z", coverage)
        .expect("checkpoint");
    assert!(!checkpoint.json.contains(&captured.markdown));

    let validated =
        validate_checkpoint(&checkpoint.path, &checkpoint.json, LIBRARY_ID).expect("validate");
    let restored = Library::from_snapshot(
        &STANDARD.decode(validated.snapshot_base64).expect("decode"),
        92,
    )
    .expect("restore");
    let projection = restored.canonical_projection().expect("projection");
    assert_eq!(projection.items.len(), 1_000);
    assert!(projection.items.values().all(|item| {
        item.captured_document
            .as_ref()
            .and_then(|view| view.value.as_ref())
            .is_some_and(|reference| reference.sha256 == captured.reference.sha256)
    }));
    assert_eq!(
        BTreeMap::from([(
            DEVICE_ID.to_owned(),
            vec![CoverageInterval::new(1, 100).unwrap()]
        )]),
        checkpoint.coverage
    );
}
