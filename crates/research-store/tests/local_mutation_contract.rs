use research_store::{
    CreateItemRequest, ENRICHMENT_MAX_ATTEMPTS, EditItemRequest, EnrichmentCandidates,
    EnrichmentProvider, EnrichmentStatus, ListQuery, OptionalTextUpdate, SearchQuery,
    StoreError, V2Store,
};

#[tokio::test]
async fn explicit_reenrichment_replaces_only_an_enrichment_owned_excerpt() {
    let directory = tempfile::tempdir().expect("library temp directory");
    let store = V2Store::init(directory.path().join("library"))
        .await
        .expect("initialize store");
    let item = store
        .create_item_with_enrichment(
            CreateItemRequest {
                url: "https://example.com/archive".into(),
                title: Some("Archive".into()),
                excerpt: None,
                favorite: false,
                language: Some("en".into()),
                saved_at: Some(1_700_000_000),
                note: String::new(),
                tags: Vec::new(),
            },
            EnrichmentProvider::Firecrawl,
        )
        .await
        .expect("create queued item");
    let first_claim = store
        .claim_item_enrichment(&item.id)
        .await
        .expect("claim initial enrichment");
    let first = store
        .apply_item_enrichment(
            &item.id,
            &first_claim.lease_token,
            &item.url,
            &item.state,
            EnrichmentCandidates {
                excerpt: Some("Short metadata description".into()),
                ..EnrichmentCandidates::default()
            },
        )
        .await
        .expect("apply initial enrichment");
    assert!(first.applied_excerpt);

    let requeued = store
        .queue_item_enrichment(&item.id, EnrichmentProvider::Firecrawl)
        .await
        .expect("requeue enrichment-owned excerpt");
    assert!(requeued.target_excerpt);
    let second_claim = store
        .claim_item_enrichment(&item.id)
        .await
        .expect("claim replacement enrichment");
    let replaced = store
        .apply_item_enrichment(
            &item.id,
            &second_claim.lease_token,
            &item.url,
            &item.state,
            EnrichmentCandidates {
                excerpt: Some("# Complete page\n\nPreserved Markdown".into()),
                ..EnrichmentCandidates::default()
            },
        )
        .await
        .expect("replace enrichment-owned excerpt");
    assert_eq!(
        replaced.item.excerpt.as_deref(),
        Some("# Complete page\n\nPreserved Markdown")
    );

    store
        .edit_item(EditItemRequest {
            item_id: item.id.clone(),
            excerpt: Some(OptionalTextUpdate::Set("Authored context".into())),
            ..EditItemRequest::default()
        })
        .await
        .expect("author excerpt");
    let protected = store
        .queue_item_enrichment(&item.id, EnrichmentProvider::Firecrawl)
        .await
        .expect("requeue after authored edit");
    assert!(!protected.target_excerpt);
    assert_eq!(protected.status, EnrichmentStatus::Skipped);

    let forced = store
        .queue_item_enrichment_replacing_excerpt(&item.id, EnrichmentProvider::Firecrawl)
        .await
        .expect("explicitly queue authored excerpt replacement");
    assert!(forced.target_excerpt);
    let stale_claim = store
        .claim_item_enrichment(&item.id)
        .await
        .expect("claim forced replacement");
    store
        .edit_item(EditItemRequest {
            item_id: item.id.clone(),
            excerpt: Some(OptionalTextUpdate::Set("Newer authored context".into())),
            ..EditItemRequest::default()
        })
        .await
        .expect("edit while re-parsing");
    let stale = store
        .apply_item_enrichment(
            &item.id,
            &stale_claim.lease_token,
            &item.url,
            &item.state,
            EnrichmentCandidates {
                excerpt: Some("Stale parsed page".into()),
                ..EnrichmentCandidates::default()
            },
        )
        .await
        .expect("complete stale replacement safely");
    assert!(!stale.applied_excerpt);
    assert_eq!(
        stale.item.excerpt.as_deref(),
        Some("Newer authored context")
    );

    store
        .queue_item_enrichment_replacing_excerpt(&item.id, EnrichmentProvider::Firecrawl)
        .await
        .expect("queue replacement of current revision");
    let replacement_claim = store
        .claim_item_enrichment(&item.id)
        .await
        .expect("claim current replacement");
    let replacement = store
        .apply_item_enrichment(
            &item.id,
            &replacement_claim.lease_token,
            &item.url,
            &item.state,
            EnrichmentCandidates {
                excerpt: Some("# Fresh parse".into()),
                ..EnrichmentCandidates::default()
            },
        )
        .await
        .expect("replace unchanged authored excerpt explicitly");
    assert!(replacement.applied_excerpt);
    assert_eq!(replacement.item.excerpt.as_deref(), Some("# Fresh parse"));
}

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
    let stale_note = store
        .edit_item(EditItemRequest {
            item_id: first.id.clone(),
            note: Some("stale replacement".into()),
            expected_note: Some(String::new()),
            ..EditItemRequest::default()
        })
        .await
        .expect_err("stale note replacement must fail");
    assert!(matches!(stale_note, StoreError::StaleEdit));
    let search = store
        .search(SearchQuery {
            text: "human".into(),
            limit: None,
            ..SearchQuery::default()
        })
        .await
        .expect("search edited note");
    assert_eq!(search.items.len(), 1);
    assert_eq!(search.items[0].id, first.id);
    assert!(
        store
            .search(SearchQuery {
                text: "Remove".into(),
                limit: None,
                ..SearchQuery::default()
            })
            .await
            .expect("search removed tag")
            .items
            .is_empty()
    );

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
    assert!(
        store
            .search(SearchQuery {
                text: "human".into(),
                limit: None,
                ..SearchQuery::default()
            })
            .await
            .expect("search hides deleted item")
            .items
            .is_empty()
    );
    assert_eq!(
        store
            .search(SearchQuery {
                text: "human".into(),
                include_deleted: true,
                limit: None,
                ..SearchQuery::default()
            })
            .await
            .expect("search includes deleted item")
            .items
            .len(),
        1
    );
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
    assert_eq!(
        store
            .search(SearchQuery {
                text: "human".into(),
                limit: None,
                ..SearchQuery::default()
            })
            .await
            .expect("search restored item")
            .items
            .len(),
        1
    );
    let status = store.status().await.expect("status after mutations");
    assert_eq!(status.active_items, 2);
    assert_eq!(status.pending_updates, 5);
    assert_eq!(status.next_sequence, 6);
    assert!(matches!(
        store
            .search(SearchQuery {
                text: "   ".into(),
                ..SearchQuery::default()
            })
            .await
            .expect_err("blank search must fail"),
        StoreError::InvalidInput(_)
    ));
    assert!(matches!(
        store
            .search(SearchQuery {
                text: "\"".into(),
                ..SearchQuery::default()
            })
            .await
            .expect_err("invalid FTS syntax must fail"),
        StoreError::InvalidInput(_)
    ));
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

#[tokio::test]
async fn enrichment_is_durable_bounded_and_never_overwrites_authored_values() {
    let directory = tempfile::tempdir().expect("library temp directory");
    let library_directory = directory.path().join("library");
    let store = V2Store::init(&library_directory)
        .await
        .expect("initialize store");

    let item = store
        .create_item_with_enrichment(
            CreateItemRequest {
                url: "https://example.com/enrich".into(),
                title: None,
                excerpt: Some(String::new()),
                favorite: false,
                language: None,
                saved_at: Some(1_700_000_000),
                note: String::new(),
                tags: Vec::new(),
            },
            EnrichmentProvider::Direct,
        )
        .await
        .expect("atomically create and queue item");
    let queued = store
        .enrichment_job(&item.id)
        .await
        .expect("read enrichment job")
        .expect("created enrichment job");
    assert_eq!(queued.status, EnrichmentStatus::Pending);
    assert!(queued.target_title);
    assert!(!queued.target_excerpt);
    assert!(queued.target_language);
    let claim = store
        .claim_next_due_enrichment_job()
        .await
        .expect("claim due enrichment job")
        .expect("one due enrichment job");
    assert_eq!(claim.job.status, EnrichmentStatus::InProgress);
    assert!(matches!(
        store
            .claim_item_enrichment(&item.id)
            .await
            .expect_err("an active lease prevents duplicate provider calls"),
        StoreError::EnrichmentJobNotPending(_)
    ));
    assert!(matches!(
        store
            .queue_item_enrichment(&item.id, EnrichmentProvider::Firecrawl)
            .await
            .expect_err("requeue cannot erase an active lease"),
        StoreError::EnrichmentJobNotPending(_)
    ));

    let moved_url = "https://example.com/enrich-moved";
    store
        .edit_item(EditItemRequest {
            item_id: item.id.clone(),
            url: Some(moved_url.into()),
            title: Some(OptionalTextUpdate::Clear),
            ..EditItemRequest::default()
        })
        .await
        .expect("author title and URL while enrichment is in flight");
    let candidates = EnrichmentCandidates {
        title: Some("Fetched title".into()),
        excerpt: Some("Fetched excerpt".into()),
        language: Some("en".into()),
    };
    assert!(matches!(
        store
            .apply_item_enrichment(
                &item.id,
                &claim.lease_token,
                &item.url,
                &item.state,
                candidates.clone(),
            )
            .await
            .expect_err("reject metadata fetched for the old URL"),
        StoreError::StaleEdit
    ));
    let still_queued = store
        .enrichment_job(&item.id)
        .await
        .expect("read job after stale enrichment")
        .expect("job remains after stale enrichment");
    assert_eq!(still_queued.status, EnrichmentStatus::InProgress);
    assert_eq!(still_queued.attempts, 0);
    let applied = store
        .apply_item_enrichment(
            &item.id,
            &claim.lease_token,
            moved_url,
            &item.state,
            candidates,
        )
        .await
        .expect("apply still-missing enrichment fields");
    assert_eq!(applied.item.title, None);
    assert_eq!(applied.item.excerpt.as_deref(), Some(""));
    assert_eq!(applied.item.language.as_deref(), Some("en"));
    assert!(!applied.applied_title);
    assert!(!applied.applied_excerpt);
    assert!(applied.applied_language);
    assert_eq!(applied.job.status, EnrichmentStatus::Succeeded);
    let cleared_requeue = store
        .queue_item_enrichment(&item.id, EnrichmentProvider::Direct)
        .await
        .expect("requeue after a human clear");
    assert_eq!(cleared_requeue.status, EnrichmentStatus::Skipped);
    assert_eq!(
        store.item(&item.id).await.expect("read cleared item").title,
        None
    );

    let retry_item = store
        .create_item_with_enrichment(
            CreateItemRequest {
                url: "https://example.com/retry".into(),
                title: None,
                excerpt: None,
                favorite: false,
                language: None,
                saved_at: Some(1_700_000_001),
                note: String::new(),
                tags: Vec::new(),
            },
            EnrichmentProvider::Firecrawl,
        )
        .await
        .expect("create retry item");
    for attempt in 1..=ENRICHMENT_MAX_ATTEMPTS {
        let claim = store
            .claim_item_enrichment(&retry_item.id)
            .await
            .expect("claim retry attempt");
        let failed = store
            .record_enrichment_failure(&retry_item.id, &claim.lease_token, "request_timeout")
            .await
            .expect("record sanitized failure");
        assert_eq!(failed.attempts, attempt);
        let expected = if attempt == ENRICHMENT_MAX_ATTEMPTS {
            EnrichmentStatus::Failed
        } else {
            EnrichmentStatus::Retry
        };
        assert_eq!(failed.status, expected);
    }
    assert!(matches!(
        store
            .record_enrichment_failure(
                &retry_item.id,
                "unused-lease",
                "secret=https://example.com",
            )
            .await
            .expect_err("reject unsanitized error detail"),
        StoreError::InvalidInput(_)
    ));

    drop(store);
    let reopened = V2Store::open(&library_directory)
        .await
        .expect("reopen store");
    let persisted = reopened
        .enrichment_job(&retry_item.id)
        .await
        .expect("read persisted retry state")
        .expect("persisted retry job");
    assert_eq!(persisted.status, EnrichmentStatus::Failed);
    assert_eq!(persisted.attempts, ENRICHMENT_MAX_ATTEMPTS);
    assert_eq!(
        persisted.last_error_kind.as_deref(),
        Some("request_timeout")
    );
}
