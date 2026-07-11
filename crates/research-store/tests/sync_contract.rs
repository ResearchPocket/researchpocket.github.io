use research_store::{
    CreateItemRequest, EditItemRequest, ListQuery, OptionalTextUpdate, RemoteBatchDisposition,
    SearchQuery, StoreError, V2Store,
};

#[tokio::test]
async fn remote_replay_is_exact_idempotent_and_convergent() {
    let root = tempfile::tempdir().expect("temporary test root");
    let first = V2Store::init(root.path().join("first"))
        .await
        .expect("first store");
    let second = V2Store::init(root.path().join("second"))
        .await
        .expect("second store");
    let first_identity = first.sync_identity().await.expect("first identity");
    let second_device = second
        .sync_identity()
        .await
        .expect("second identity")
        .device_id;
    assert!(
        second
            .adopt_library_id_if_pristine(&first_identity.library_id)
            .await
            .expect("adopt remote library")
    );
    let adopted = second.sync_identity().await.expect("adopted identity");
    assert_eq!(adopted.library_id, first_identity.library_id);
    assert_eq!(adopted.device_id, second_device);
    let configuration = second
        .configure_sync("owner", "private-library", "main")
        .await
        .expect("configure synchronization");
    assert_eq!(
        second
            .configure_sync("owner", "private-library", "main")
            .await
            .expect("repeat same configuration"),
        configuration
    );
    assert!(matches!(
        second
            .configure_sync("owner", "another-library", "main")
            .await
            .expect_err("remote replacement must be explicit"),
        StoreError::InvalidInput(_)
    ));
    second
        .record_immutable_remote_blob("sync/v1/library.json", &"f".repeat(40))
        .await
        .expect("record immutable genesis");
    assert!(matches!(
        second
            .record_immutable_remote_blob("sync/v1/library.json", &"e".repeat(40))
            .await
            .expect_err("genesis identity must not change"),
        StoreError::SyncIntegrity(_)
    ));

    let item = first
        .create_item(CreateItemRequest {
            url: "https://example.com/sync-contract".into(),
            title: Some("Initial title".into()),
            excerpt: None,
            favorite: false,
            language: None,
            saved_at: Some(1_700_000_000),
            note: "private note".into(),
            tags: vec!["sync".into()],
        })
        .await
        .expect("create initial item");
    let initial = first
        .pending_batches()
        .await
        .expect("initial outbox")
        .remove(0);
    let initial_sha = "a".repeat(40);
    let applied = second
        .receive_remote_batch(
            &initial.path,
            &initial_sha,
            initial.envelope_json.as_bytes(),
        )
        .await
        .expect("apply initial remote batch");
    assert_eq!(applied.disposition, RemoteBatchDisposition::Applied);
    let duplicate = second
        .receive_remote_batch(
            &initial.path,
            &initial_sha,
            initial.envelope_json.as_bytes(),
        )
        .await
        .expect("repeat initial remote batch");
    assert_eq!(
        duplicate.disposition,
        RemoteBatchDisposition::AlreadyApplied
    );
    let acknowledged = first
        .receive_remote_batch(
            &initial.path,
            &initial_sha,
            initial.envelope_json.as_bytes(),
        )
        .await
        .expect("confirm initial upload");
    assert!(acknowledged.acknowledged_outbox);

    first
        .edit_item(EditItemRequest {
            item_id: item.id.clone(),
            favorite: Some(true),
            ..EditItemRequest::default()
        })
        .await
        .expect("first concurrent edit");
    second
        .edit_item(EditItemRequest {
            item_id: item.id.clone(),
            title: Some(OptionalTextUpdate::Set("Remote title".into())),
            ..EditItemRequest::default()
        })
        .await
        .expect("second concurrent edit");
    let first_edit = first
        .pending_batches()
        .await
        .expect("first edit outbox")
        .remove(0);
    let second_edit = second
        .pending_batches()
        .await
        .expect("second edit outbox")
        .remove(0);
    let first_edit_sha = "b".repeat(40);
    let second_edit_sha = "c".repeat(40);

    let reordered = V2Store::init(root.path().join("reordered"))
        .await
        .expect("reordered store");
    reordered
        .adopt_library_id_if_pristine(&first_identity.library_id)
        .await
        .expect("adopt reordered library");
    reordered
        .receive_remote_batch(
            &second_edit.path,
            &second_edit_sha,
            second_edit.envelope_json.as_bytes(),
        )
        .await
        .expect("accept causally later batch first");
    reordered
        .receive_remote_batch(
            &initial.path,
            &initial_sha,
            initial.envelope_json.as_bytes(),
        )
        .await
        .expect("accept causal predecessor later");
    let reordered_projection = reordered
        .list(ListQuery {
            include_deleted: true,
            ..ListQuery::default()
        })
        .await
        .expect("projection after reordered replay");
    assert_eq!(reordered_projection.items.len(), 1);
    assert_eq!(
        reordered_projection.items[0].title.as_deref(),
        Some("Remote title")
    );
    assert_eq!(
        reordered
            .status()
            .await
            .expect("reordered sync status")
            .deferred_updates,
        0
    );

    first
        .receive_remote_batch(
            &second_edit.path,
            &second_edit_sha,
            second_edit.envelope_json.as_bytes(),
        )
        .await
        .expect("first receives second edit");
    second
        .receive_remote_batch(
            &first_edit.path,
            &first_edit_sha,
            first_edit.envelope_json.as_bytes(),
        )
        .await
        .expect("second receives first edit");
    first
        .receive_remote_batch(
            &first_edit.path,
            &first_edit_sha,
            first_edit.envelope_json.as_bytes(),
        )
        .await
        .expect("first edit upload confirmation");
    second
        .receive_remote_batch(
            &second_edit.path,
            &second_edit_sha,
            second_edit.envelope_json.as_bytes(),
        )
        .await
        .expect("second edit upload confirmation");

    let query = ListQuery {
        include_deleted: true,
        ..ListQuery::default()
    };
    let first_projection = first.list(query.clone()).await.expect("first projection");
    let second_projection = second.list(query).await.expect("second projection");
    assert_eq!(first_projection, second_projection);
    assert!(first_projection.items[0].favorite);
    assert_eq!(
        first_projection.items[0].title.as_deref(),
        Some("Remote title")
    );
    assert_eq!(
        second
            .search(SearchQuery {
                text: "Remote title".into(),
                ..SearchQuery::default()
            })
            .await
            .expect("remote projection search")
            .page
            .total,
        1
    );
    assert!(
        first
            .pending_batches()
            .await
            .expect("first drained")
            .is_empty()
    );
    assert!(
        second
            .pending_batches()
            .await
            .expect("second drained")
            .is_empty()
    );

    let mut collision: serde_json::Value =
        serde_json::from_str(&second_edit.envelope_json).expect("stored envelope JSON");
    collision["created_at"] = serde_json::Value::String("2026-07-11T01:02:03.000Z".into());
    let collision = serde_json::to_vec(&collision).expect("collision JSON");
    let error = second
        .receive_remote_batch(&second_edit.path, &"d".repeat(40), &collision)
        .await
        .expect_err("byte-different identity collision must fail");
    assert!(matches!(error, StoreError::SyncIntegrity(_)));
    assert_eq!(
        second
            .list(ListQuery {
                include_deleted: true,
                ..ListQuery::default()
            })
            .await
            .expect("projection after rejected collision"),
        second_projection
    );
}
