use research_store::{CreateZenDocumentRequest, EditZenDocumentRequest, V2Store};

/// The workspace list must stay metadata-only and every edit must queue exactly
/// one aggregate-scoped operation.
#[tokio::test]
async fn zen_documents_project_metadata_and_queue_one_operation_per_edit() {
    let root = tempfile::tempdir().expect("temporary test root");
    let store = V2Store::init(root.path().join("library"))
        .await
        .expect("store");

    let created = store
        .create_zen_document(CreateZenDocumentRequest {
            title: Some("Today".into()),
            body: "- [x] Ship it\n- [ ] Review #132\n\nGrocery run.".into(),
            tags: vec!["reading".into()],
        })
        .await
        .expect("create document");
    assert_eq!((created.todo_total, created.todo_done), (2, 1));

    let listed = store.list_zen_documents().await.expect("list");
    assert_eq!(listed.len(), 1);
    assert_eq!(listed[0].title.as_deref(), Some("Today"));
    assert_eq!(listed[0].tags, ["reading"]);
    assert_eq!(listed[0].byte_length, created.byte_length);

    let edited = store
        .edit_zen_document(EditZenDocumentRequest {
            document_id: created.document_id.clone(),
            body: Some("- [x] Ship it\n- [x] Review #132\n\nGrocery run.".into()),
            add_tags: vec!["crdt".into()],
            ..EditZenDocumentRequest::default()
        })
        .await
        .expect("edit document");
    assert_eq!(
        (edited.todo_total, edited.todo_done),
        (2, 2),
        "todo counts follow the body rather than a stored counter"
    );
    assert_eq!(edited.tags, ["crdt", "reading"]);

    let reopened = store
        .zen_document(&created.document_id)
        .await
        .expect("read document body");
    assert!(reopened.body.contains("- [x] Review #132"));

    // Deleting hides the document from the workspace without destroying it.
    store
        .delete_zen_document(&created.document_id)
        .await
        .expect("delete");
    assert!(store.list_zen_documents().await.expect("list").is_empty());
    store
        .restore_zen_document(&created.document_id)
        .await
        .expect("restore");
    assert_eq!(store.list_zen_documents().await.expect("list").len(), 1);

    // One operation per mutation: create, edit, delete, restore.
    let queued: i64 = sqlx_scalar(&store, "SELECT COUNT(*) FROM aggregate_outbox").await;
    assert_eq!(queued, 4);
    let items: i64 = sqlx_scalar(&store, "SELECT COUNT(*) FROM outbox").await;
    assert_eq!(items, 0, "zen work never lands in the protocol-v1 outbox");
}

async fn sqlx_scalar(store: &V2Store, query: &'static str) -> i64 {
    let pool = sqlx::sqlite::SqlitePoolOptions::new()
        .max_connections(1)
        .connect(&format!(
            "sqlite://{}",
            store.database_path().to_string_lossy()
        ))
        .await
        .expect("open database");
    sqlx::query_scalar(query)
        .fetch_one(&pool)
        .await
        .expect("scalar query")
}
