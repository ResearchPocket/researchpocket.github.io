use research_store::{
    CreateItemRequest, EditItemRequest, ListQuery, OptionalTextUpdate, StoreError, V2Store,
};

#[tokio::test]
async fn local_mutations_are_atomic_durable_and_lifecycle_safe() {
    let directory = tempfile::tempdir().expect("library temp directory");
    let library_directory = directory.path().join("library");
    let store = V2Store::init(&library_directory)
        .await
        .expect("initialize store");

    let first = store
        .create_item(CreateItemRequest {
            url: "https://example.com/shared".into(),
            title: None,
            excerpt: None,
            favorite: false,
            language: None,
            saved_at: Some(1_700_000_000),
            note: String::new(),
            tags: vec!["Keep".into(), "Remove".into()],
        })
        .await
        .expect("create first item");
    assert!(first.title.is_none());

    let duplicate = store
        .create_item(CreateItemRequest {
            url: first.url.clone(),
            title: Some("Separate intent".into()),
            excerpt: None,
            favorite: false,
            language: None,
            saved_at: Some(1_700_000_001),
            note: String::new(),
            tags: Vec::new(),
        })
        .await
        .expect("create duplicate URL as a distinct item");
    assert_ne!(duplicate.id, first.id);

    let edited = store
        .edit_item(EditItemRequest {
            item_id: first.id.clone(),
            title: Some(OptionalTextUpdate::Set(String::new())),
            excerpt: Some(OptionalTextUpdate::Set(String::new())),
            favorite: Some(true),
            language: Some(OptionalTextUpdate::Set(String::new())),
            note: Some("human 😀 note".into()),
            add_tags: vec!["Added".into()],
            remove_tags: vec!["Remove".into()],
            ..EditItemRequest::default()
        })
        .await
        .expect("edit item");
    assert_eq!(edited.title.as_deref(), Some(""));
    assert_eq!(edited.excerpt.as_deref(), Some(""));
    assert_eq!(edited.language.as_deref(), Some(""));
    assert_eq!(edited.note.as_deref(), Some("human 😀 note"));
    assert!(edited.favorite);
    assert_eq!(edited.tags, ["Added", "Keep"]);

    let no_changes = store
        .edit_item(EditItemRequest {
            item_id: first.id.clone(),
            ..EditItemRequest::default()
        })
        .await
        .expect_err("empty edit must fail");
    assert!(matches!(no_changes, StoreError::NoChanges));

    let deleted = store.delete_item(&first.id).await.expect("delete item");
    assert_eq!(deleted.state, "deleted");
    assert!(store.delete_item(&first.id).await.is_err());

    let visible = store
        .list(ListQuery {
            limit: None,
            ..ListQuery::default()
        })
        .await
        .expect("list active items");
    assert_eq!(visible.items.len(), 1);
    assert_eq!(visible.items[0].id, duplicate.id);
    let with_deleted = store
        .list(ListQuery {
            include_deleted: true,
            limit: None,
            ..ListQuery::default()
        })
        .await
        .expect("list including deleted items");
    assert_eq!(with_deleted.items.len(), 2);

    let restored = store.restore_item(&first.id).await.expect("restore item");
    assert_eq!(restored.state, "active");
    let status = store.status().await.expect("status after mutations");
    assert_eq!(status.active_items, 2);
    assert_eq!(status.pending_updates, 5);
    assert_eq!(status.next_sequence, 6);
    drop(store);

    let reopened = V2Store::open(&library_directory)
        .await
        .expect("reopen store");
    let status = reopened.status().await.expect("status after restart");
    assert_eq!(status.active_items, 2);
    assert_eq!(status.pending_updates, 5);
    assert_eq!(status.next_sequence, 6);
    let persisted = reopened
        .list(ListQuery {
            limit: None,
            ..ListQuery::default()
        })
        .await
        .expect("list after restart");
    let first = persisted
        .items
        .iter()
        .find(|item| item.id == first.id)
        .expect("edited item after restart");
    assert_eq!(first.title.as_deref(), Some(""));
    assert_eq!(first.note.as_deref(), Some("human 😀 note"));
    assert_eq!(first.tags, ["Added", "Keep"]);
}
