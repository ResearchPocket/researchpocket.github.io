use std::collections::BTreeMap;
use std::fs;
use std::path::{Path, PathBuf};

use research_store::{ListQuery, V2Store};
use sha2::{Digest, Sha256};
use sqlx::sqlite::SqliteConnectOptions;
use sqlx::{Connection, SqliteConnection};

#[tokio::test]
async fn import_v1_is_idempotent_read_only_and_preserves_fields() {
    let source_directory = tempfile::tempdir().expect("source temp directory");
    let source = source_directory.path().join("research.sqlite");
    create_v1_fixture(&source).await;
    let source_before = directory_bytes(source_directory.path());
    let source_sha256 = file_sha256(&source);

    let target_directory = tempfile::tempdir().expect("target temp directory");
    let library_directory = target_directory.path().join("library");
    let store = V2Store::init(&library_directory)
        .await
        .expect("initialize V2 store");

    let first = store.import_v1(&source).await.expect("first V1 import");
    assert_eq!(first.source_sha256, source_sha256);
    assert!(first.source_unchanged);
    assert_eq!(first.scanned, 3);
    assert_eq!(first.imported, 2);
    assert_eq!(first.skipped, 0);
    assert_eq!(first.rejection_count, 2);
    assert_eq!(first.tags_imported, 3);
    assert!(
        first
            .rejections
            .iter()
            .all(|rejection| !rejection.reason.contains("not a url"))
    );

    let listed = store
        .list(ListQuery {
            limit: None,
            ..ListQuery::default()
        })
        .await
        .expect("list imported items");
    assert_eq!(listed.page.total, 2);
    assert_eq!(listed.items.len(), 2);
    assert!(
        listed
            .items
            .iter()
            .all(|item| item.url == "https://example.com/shared")
    );

    let complete = listed
        .items
        .iter()
        .find(|item| item.title.as_deref() == Some("First save"))
        .expect("complete imported row");
    assert_eq!(complete.excerpt.as_deref(), Some(""));
    assert_eq!(complete.note.as_deref(), Some("private authored note"));
    assert!(complete.favorite);
    assert_eq!(complete.language.as_deref(), Some(""));
    assert_eq!(complete.tags, [" spaced ", "Mixed Case"]);

    let nullable = listed
        .items
        .iter()
        .find(|item| item.title.is_none())
        .expect("nullable imported row");
    assert!(nullable.excerpt.is_none());
    assert!(nullable.note.is_none());
    assert!(!nullable.favorite);
    assert!(nullable.language.is_none());
    assert_eq!(nullable.tags, ["local"]);

    let status = store.status().await.expect("status after first import");
    assert_eq!(status.active_items, 2);
    assert_eq!(status.pending_updates, 1);
    assert_eq!(status.imported_items, 2);
    assert_eq!(status.next_sequence, 2);
    drop(store);

    let reopened = V2Store::open(&library_directory)
        .await
        .expect("reopen initialized store");
    let second = reopened
        .import_v1(&source)
        .await
        .expect("repeated V1 import");
    assert_eq!(second.imported, 0);
    assert_eq!(second.skipped, 2);
    assert_eq!(second.rejection_count, 2);
    let status = reopened
        .status()
        .await
        .expect("status after repeated import");
    assert_eq!(status.active_items, 2);
    assert_eq!(status.pending_updates, 1);
    assert_eq!(status.next_sequence, 2);

    assert_eq!(directory_bytes(source_directory.path()), source_before);
    assert_private_sentinel_absent(&library_directory, b"NEVER_IMPORT_ME");
}

async fn create_v1_fixture(path: &Path) {
    let options = SqliteConnectOptions::new()
        .filename(path)
        .create_if_missing(true);
    let mut connection = SqliteConnection::connect_with(&options)
        .await
        .expect("create V1 fixture");
    for statement in [
        "CREATE TABLE providers (id INTEGER PRIMARY KEY, name TEXT NOT NULL)",
        "CREATE TABLE items (id INTEGER PRIMARY KEY, uri TEXT, title TEXT, excerpt TEXT, time_added INTEGER, favorite INTEGER, lang TEXT, provider_id INTEGER, notes TEXT)",
        "CREATE TABLE tags (tag_name TEXT PRIMARY KEY)",
        "CREATE TABLE item_tags (item_id INTEGER, tag_name TEXT, PRIMARY KEY (item_id, tag_name))",
        "CREATE TABLE secrets (user_id INTEGER PRIMARY KEY, pocket_consumer_key TEXT, pocket_access_token TEXT)",
        "INSERT INTO providers (id, name) VALUES (1, 'pocket'), (2, 'local')",
        "INSERT INTO items VALUES (10, 'https://example.com/shared', 'First save', '', 1700000000, 1, '', 1, 'private authored note')",
        "INSERT INTO items VALUES (20, 'https://example.com/shared', NULL, NULL, 1700000100, 0, NULL, 2, NULL)",
        "INSERT INTO items VALUES (30, 'not a url', 'Malformed', NULL, 1700000200, 0, NULL, 1, NULL)",
        "INSERT INTO tags (tag_name) VALUES ('Mixed Case'), (' spaced '), ('local'), ('')",
        "INSERT INTO item_tags VALUES (10, 'Mixed Case'), (10, ' spaced '), (10, ''), (20, 'local')",
        "INSERT INTO secrets VALUES (0, 'NEVER_IMPORT_ME', 'NEVER_IMPORT_ME')",
    ] {
        sqlx::query(statement)
            .execute(&mut connection)
            .await
            .expect("build V1 fixture");
    }
    connection.close().await.expect("close V1 fixture");
}

fn directory_bytes(path: &Path) -> BTreeMap<PathBuf, Vec<u8>> {
    fs::read_dir(path)
        .expect("read source directory")
        .map(|entry| {
            let entry = entry.expect("source directory entry");
            let name = PathBuf::from(entry.file_name());
            let bytes = fs::read(entry.path()).expect("read source entry");
            (name, bytes)
        })
        .collect()
}

fn file_sha256(path: &Path) -> String {
    Sha256::digest(fs::read(path).expect("read source file"))
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect()
}

fn assert_private_sentinel_absent(path: &Path, sentinel: &[u8]) {
    for entry in fs::read_dir(path).expect("read target directory") {
        let path = entry.expect("target directory entry").path();
        if path.is_file() {
            let bytes = fs::read(path).expect("read target file");
            assert!(
                !bytes
                    .windows(sentinel.len())
                    .any(|window| window == sentinel)
            );
        }
    }
}
