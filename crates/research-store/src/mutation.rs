use std::collections::BTreeSet;

use chrono::{DateTime, SecondsFormat, Utc};
use research_domain::{CanonicalProjection, ItemSeed, Library, LifecycleState};
use sqlx::{Row, SqliteConnection};
use uuid::Uuid;

use crate::import::persist_item_projection;
use crate::store::{fresh_peer_id, now_rfc3339, sha256_hex};
use crate::{
    CreateItemRequest, EditItemRequest, OptionalTextUpdate, StoreError, StoreResult,
    StoredItem, V2Store,
};

impl V2Store {
    pub async fn create_item(&self, request: CreateItemRequest) -> StoreResult<StoredItem> {
        let item_id = Uuid::now_v7().to_string();
        let saved_at = request.saved_at.unwrap_or_else(|| Utc::now().timestamp());
        validate_timestamp(saved_at)?;
        let seed = ItemSeed {
            item_id: item_id.clone(),
            url: request.url,
            title: request.title,
            excerpt: request.excerpt,
            favorite: request.favorite,
            language: request.language,
            saved_at,
            note: request.note,
            tags: request.tags,
        };

        self.commit_item_mutation(&item_id, move |library, projection, prefix| {
            if projection.items.contains_key(&seed.item_id) {
                return Err(StoreError::InvalidInput(
                    "generated item identity already exists".into(),
                ));
            }
            library.create_item(&seed, &format!("{prefix}/create"))?;
            Ok(())
        })
        .await
    }

    pub async fn edit_item(&self, request: EditItemRequest) -> StoreResult<StoredItem> {
        if !request.has_changes() {
            return Err(StoreError::NoChanges);
        }
        if let Some(saved_at) = request.saved_at {
            validate_timestamp(saved_at)?;
        }
        let has_non_note_changes = request.url.is_some()
            || request.title.is_some()
            || request.excerpt.is_some()
            || request.favorite.is_some()
            || request.language.is_some()
            || request.saved_at.is_some()
            || !request.add_tags.is_empty()
            || !request.remove_tags.is_empty();
        let add_tags = request.add_tags.iter().cloned().collect::<BTreeSet<_>>();
        let remove_tags = request.remove_tags.iter().cloned().collect::<BTreeSet<_>>();
        if let Some(tag) = add_tags.intersection(&remove_tags).next() {
            return Err(StoreError::InvalidInput(format!(
                "tag {tag:?} cannot be added and removed in one edit"
            )));
        }

        let result_item_id = request.item_id.clone();
        let mutation_item_id = result_item_id.clone();
        self.commit_item_mutation(&result_item_id, move |library, projection, prefix| {
            let current = projection
                .items
                .get(&mutation_item_id)
                .ok_or_else(|| StoreError::ItemNotFound(mutation_item_id.clone()))?;
            if request.note.is_some()
                && request
                    .expected_note
                    .as_ref()
                    .is_some_and(|expected| expected != &current.note)
            {
                return Err(StoreError::StaleEdit);
            }
            if request.note.as_ref() == Some(&current.note) && !has_non_note_changes {
                return Err(StoreError::NoChanges);
            }

            if let Some(url) = &request.url {
                library.write_url(&mutation_item_id, &format!("{prefix}/url"), url)?;
            }
            if let Some(title) = &request.title {
                library.write_title(
                    &mutation_item_id,
                    &format!("{prefix}/title"),
                    optional_text(title),
                )?;
            }
            if let Some(excerpt) = &request.excerpt {
                library.write_excerpt(
                    &mutation_item_id,
                    &format!("{prefix}/excerpt"),
                    optional_text(excerpt),
                )?;
            }
            if let Some(favorite) = request.favorite {
                library.write_favorite(
                    &mutation_item_id,
                    &format!("{prefix}/favorite"),
                    favorite,
                )?;
            }
            if let Some(language) = &request.language {
                library.write_language(
                    &mutation_item_id,
                    &format!("{prefix}/language"),
                    optional_text(language),
                )?;
            }
            if let Some(saved_at) = request.saved_at {
                library.write_saved_at(
                    &mutation_item_id,
                    &format!("{prefix}/saved-at"),
                    saved_at,
                )?;
            }
            if let Some(note) = &request.note
                && note != &current.note
            {
                let current_utf16_length = current.note.encode_utf16().count();
                library.splice_note_utf16(&mutation_item_id, 0, current_utf16_length, note)?;
            }
            for tag in &remove_tags {
                library.remove_tag(&mutation_item_id, tag)?;
            }
            for (index, tag) in add_tags.iter().enumerate() {
                library.add_tag(
                    &mutation_item_id,
                    tag,
                    &format!("{prefix}/tag-add/{index:020}"),
                )?;
            }
            Ok(())
        })
        .await
    }

    pub async fn delete_item(&self, item_id: &str) -> StoreResult<StoredItem> {
        self.transition_item(item_id, LifecycleState::Deleted).await
    }

    pub async fn restore_item(&self, item_id: &str) -> StoreResult<StoredItem> {
        self.transition_item(item_id, LifecycleState::Active).await
    }

    async fn transition_item(
        &self,
        item_id: &str,
        state: LifecycleState,
    ) -> StoreResult<StoredItem> {
        let result_item_id = item_id.to_owned();
        let mutation_item_id = result_item_id.clone();
        self.commit_item_mutation(&result_item_id, move |library, projection, prefix| {
            if !projection.items.contains_key(&mutation_item_id) {
                return Err(StoreError::ItemNotFound(mutation_item_id.clone()));
            }
            library.transition_lifecycle(
                &mutation_item_id,
                &format!("{prefix}/lifecycle"),
                state,
            )?;
            Ok(())
        })
        .await
    }

    async fn commit_item_mutation<F>(&self, item_id: &str, mutate: F) -> StoreResult<StoredItem>
    where
        F: FnOnce(&Library, &CanonicalProjection, &str) -> StoreResult<()>,
    {
        let mut connection = self.pool.acquire().await?;
        sqlx::query("BEGIN IMMEDIATE")
            .execute(&mut *connection)
            .await?;
        let result = apply_item_mutation(&mut connection, item_id, mutate).await;
        match result {
            Ok(item) => {
                sqlx::query("COMMIT").execute(&mut *connection).await?;
                Ok(item)
            }
            Err(error) => {
                let _ = sqlx::query("ROLLBACK").execute(&mut *connection).await;
                Err(error)
            }
        }
    }
}

async fn apply_item_mutation<F>(
    connection: &mut SqliteConnection,
    item_id: &str,
    mutate: F,
) -> StoreResult<StoredItem>
where
    F: FnOnce(&Library, &CanonicalProjection, &str) -> StoreResult<()>,
{
    let library_id = metadata(connection, "library_id").await?;
    let device_id = metadata(connection, "device_id").await?;
    let sequence_text: String =
        sqlx::query_scalar("SELECT next_sequence FROM devices WHERE device_id = ?")
            .bind(&device_id)
            .fetch_one(&mut *connection)
            .await?;
    let sequence = sequence_text
        .parse::<u64>()
        .map_err(|_| StoreError::InvalidStore("invalid device sequence".into()))?;
    let state = sqlx::query(
        "SELECT snapshot, snapshot_sha256 FROM canonical_state WHERE singleton = 1",
    )
    .fetch_one(&mut *connection)
    .await?;
    let snapshot: Vec<u8> = state.try_get("snapshot")?;
    let expected_snapshot_sha256: String = state.try_get("snapshot_sha256")?;
    if sha256_hex(&snapshot) != expected_snapshot_sha256 {
        return Err(StoreError::InvalidStore(
            "canonical snapshot checksum mismatch".into(),
        ));
    }

    let library = Library::from_snapshot(&snapshot, fresh_peer_id())?;
    let before = library.version();
    let before_projection = library.canonical_projection()?;
    let prefix = format!("{device_id}/{sequence_text}/mutation/{item_id}");
    mutate(&library, &before_projection, &prefix)?;

    let now = now_rfc3339();
    let envelope = library.export_envelope(&before, &library_id, &device_id, sequence, &now)?;
    let new_snapshot = library.export_snapshot()?;
    let projection = library.canonical_projection()?;
    let item = projection
        .items
        .get(item_id)
        .ok_or_else(|| StoreError::ItemNotFound(item_id.to_owned()))?;
    let stored_item = stored_item(item_id, item)?;

    persist_item_projection(connection, item_id, item).await?;
    sqlx::query(
        "UPDATE canonical_state SET snapshot = ?, snapshot_sha256 = ?, updated_at = ? \
         WHERE singleton = 1",
    )
    .bind(&new_snapshot)
    .bind(sha256_hex(&new_snapshot))
    .bind(&now)
    .execute(&mut *connection)
    .await?;

    let envelope_json = serde_json::to_string(&envelope)?;
    sqlx::query(
        "INSERT INTO batches \
         (device_id, sequence, payload_sha256, protocol_version, library_id, path, \
          envelope_json, origin, applied_at) \
         VALUES (?, ?, ?, ?, ?, ?, ?, 'local', ?)",
    )
    .bind(&envelope.device_id)
    .bind(&envelope.sequence)
    .bind(&envelope.payload_sha256)
    .bind(i64::from(envelope.protocol_version))
    .bind(&envelope.library_id)
    .bind(envelope.path())
    .bind(envelope_json)
    .bind(&now)
    .execute(&mut *connection)
    .await?;
    sqlx::query("INSERT INTO outbox (device_id, sequence, enqueued_at) VALUES (?, ?, ?)")
        .bind(&envelope.device_id)
        .bind(&envelope.sequence)
        .bind(&now)
        .execute(&mut *connection)
        .await?;
    let next = sequence
        .checked_add(1)
        .ok_or(StoreError::NumericRange("device sequence"))?;
    sqlx::query("UPDATE devices SET next_sequence = ? WHERE device_id = ?")
        .bind(format!("{next:020}"))
        .bind(&device_id)
        .execute(&mut *connection)
        .await?;

    Ok(stored_item)
}

fn optional_text(update: &OptionalTextUpdate) -> Option<&str> {
    match update {
        OptionalTextUpdate::Set(value) => Some(value),
        OptionalTextUpdate::Clear => None,
    }
}

fn validate_timestamp(saved_at: i64) -> StoreResult<()> {
    DateTime::<Utc>::from_timestamp(saved_at, 0)
        .map(|_| ())
        .ok_or_else(|| StoreError::InvalidInput("saved time is out of range".into()))
}

fn stored_item(
    item_id: &str,
    item: &research_domain::CanonicalItem,
) -> StoreResult<StoredItem> {
    let saved_at = DateTime::<Utc>::from_timestamp(item.saved_at.value, 0)
        .ok_or_else(|| StoreError::InvalidStore("an item has an invalid timestamp".into()))?
        .to_rfc3339_opts(SecondsFormat::Secs, true);
    let state = match item.lifecycle.state {
        LifecycleState::Active => "active",
        LifecycleState::Deleted => "deleted",
    };
    Ok(StoredItem {
        id: item_id.to_owned(),
        url: item.url.value.clone(),
        title: item.title.value.clone(),
        excerpt: item.excerpt.value.clone(),
        note: (!item.note.is_empty()).then(|| item.note.clone()),
        favorite: item.favorite.value,
        language: item.language.value.clone(),
        saved_at,
        tags: item.tags.clone(),
        state: state.to_owned(),
    })
}

async fn metadata(connection: &mut SqliteConnection, key: &str) -> StoreResult<String> {
    sqlx::query_scalar("SELECT value FROM store_meta WHERE key = ?")
        .bind(key)
        .fetch_optional(&mut *connection)
        .await?
        .ok_or_else(|| StoreError::InvalidStore(format!("missing metadata key {key}")))
}
