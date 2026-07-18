use std::collections::BTreeSet;

use base64::{Engine as _, engine::general_purpose::STANDARD};
use serde::{Deserialize, Serialize};
use wasm_bindgen::prelude::*;

use crate::{
    CanonicalProjection, DomainError, DomainResult, ItemSeed, Library, LibraryGenesis,
    LifecycleState, UpdateEnvelope,
    identity::validate_uuid_v7,
    pack::{create_operation_pack, unpack_operation_pack},
};

#[derive(Serialize)]
struct BrowserProjection {
    schema_version: u8,
    items: Vec<BrowserItem>,
}

#[derive(Serialize)]
struct BrowserItem {
    id: String,
    url: String,
    title: Option<String>,
    excerpt: Option<String>,
    note: Option<String>,
    favorite: bool,
    language: Option<String>,
    saved_at: i64,
    tags: Vec<String>,
    state: &'static str,
}

#[derive(Serialize)]
struct MutationResult {
    snapshot: String,
    projection: BrowserProjection,
    /// Serialized immutable envelope, ready to persist in the browser outbox.
    envelope: String,
}

#[derive(Serialize)]
struct RemoteResult {
    snapshot: String,
    projection: BrowserProjection,
    pending_indices: Vec<usize>,
}

#[derive(Deserialize)]
#[serde(tag = "type", rename_all = "snake_case", deny_unknown_fields)]
enum BrowserMutation {
    Create {
        item_id: String,
        url: String,
        title: NullableText,
        excerpt: NullableText,
        favorite: bool,
        language: NullableText,
        saved_at: i64,
        note: NullableText,
        tags: Vec<String>,
    },
    Edit {
        item_id: String,
        #[serde(default)]
        url: OptionalField<String>,
        #[serde(default)]
        title: OptionalField<TextUpdate>,
        #[serde(default)]
        excerpt: OptionalField<TextUpdate>,
        #[serde(default)]
        favorite: OptionalField<bool>,
        #[serde(default)]
        language: OptionalField<TextUpdate>,
        #[serde(default)]
        saved_at: OptionalField<i64>,
        #[serde(default)]
        note: OptionalField<TextUpdate>,
        #[serde(default)]
        expected_note: OptionalField<NullableText>,
        #[serde(default)]
        add_tags: Vec<String>,
        #[serde(default)]
        remove_tags: Vec<String>,
    },
    Delete {
        item_id: String,
    },
    Restore {
        item_id: String,
    },
}

#[derive(Deserialize)]
#[serde(tag = "type", rename_all = "snake_case", deny_unknown_fields)]
enum TextUpdate {
    Set { value: String },
    Clear,
}

#[derive(Deserialize)]
#[serde(transparent)]
struct NullableText(Option<String>);

struct OptionalField<T>(Option<T>);

impl<T> Default for OptionalField<T> {
    fn default() -> Self {
        Self(None)
    }
}

impl<'de, T> Deserialize<'de> for OptionalField<T>
where
    T: Deserialize<'de>,
{
    fn deserialize<D>(deserializer: D) -> Result<Self, D::Error>
    where
        D: serde::Deserializer<'de>,
    {
        T::deserialize(deserializer).map(|value| Self(Some(value)))
    }
}

/// Create an empty canonical snapshot for one browser replica.
///
/// `peer_id` is unsigned decimal text, not a JavaScript number.
#[wasm_bindgen(js_name = initializeLibrary)]
pub fn initialize_library(peer_id: &str) -> Result<String, JsValue> {
    initialize(peer_id).map_err(js_error)
}

/// Materialize the allowlisted browser projection from a canonical snapshot.
#[wasm_bindgen(js_name = materializeLibrary)]
pub fn materialize_library(snapshot_base64: &str, peer_id: &str) -> Result<String, JsValue> {
    materialize(snapshot_base64, peer_id).map_err(js_error)
}

/// Apply exactly one local mutation and return the next durable browser state.
///
/// The input snapshot is never mutated. On any error the caller keeps its
/// original snapshot, projection, sequence, and outbox unchanged.
#[wasm_bindgen(js_name = applyMutation)]
#[allow(clippy::too_many_arguments)]
pub fn apply_mutation(
    snapshot_base64: &str,
    peer_id: &str,
    library_id: &str,
    device_id: &str,
    sequence: &str,
    created_at: &str,
    mutation_json: &str,
) -> Result<String, JsValue> {
    apply_local_mutation(
        snapshot_base64,
        peer_id,
        library_id,
        device_id,
        sequence,
        created_at,
        mutation_json,
    )
    .map_err(js_error)
}

/// Apply remote immutable envelopes in one Loro session.
///
/// `envelope_json_array` is a JSON array of envelope JSON strings. Indices
/// returned in `pending_indices` still lack a causal predecessor after every
/// supplied envelope has been offered to the document.
#[wasm_bindgen(js_name = applyRemoteEnvelopes)]
pub fn apply_remote_envelopes(
    snapshot_base64: &str,
    peer_id: &str,
    expected_library_id: &str,
    envelope_json_array: &str,
) -> Result<String, JsValue> {
    apply_remote(
        snapshot_base64,
        peer_id,
        expected_library_id,
        envelope_json_array,
    )
    .map_err(js_error)
}

/// Create the immutable protocol genesis with the native domain constants.
#[wasm_bindgen(js_name = createSyncGenesis)]
pub fn create_sync_genesis(library_id: &str, created_at: &str) -> Result<String, JsValue> {
    let genesis = LibraryGenesis::new(library_id, created_at).map_err(js_error)?;
    serde_json::to_string(&genesis).map_err(|error| js_error(error.into()))
}

/// Validate remote protocol genesis and return its canonical library identity.
#[wasm_bindgen(js_name = validateSyncGenesis)]
pub fn validate_sync_genesis(genesis_json: &str) -> Result<String, JsValue> {
    let genesis: LibraryGenesis = serde_json::from_str(genesis_json)
        .map_err(DomainError::from)
        .map_err(js_error)?;
    genesis.validate().map_err(js_error)?;
    Ok(genesis.library_id)
}

/// Build one deterministic immutable operation pack from envelope JSON strings.
#[wasm_bindgen(js_name = createOperationPack)]
pub fn create_operation_pack_wasm(envelope_json_array: &str) -> Result<String, JsValue> {
    let envelopes: Vec<String> = serde_json::from_str(envelope_json_array)
        .map_err(DomainError::from)
        .map_err(js_error)?;
    let artifact = create_operation_pack(&envelopes).map_err(js_error)?;
    serde_json::to_string(&artifact).map_err(|error| js_error(error.into()))
}

/// Validate and unpack one immutable operation pack into exact envelope JSON strings.
#[wasm_bindgen(js_name = unpackOperationPack)]
pub fn unpack_operation_pack_wasm(path: &str, pack_json: &str) -> Result<String, JsValue> {
    let artifact = unpack_operation_pack(path, pack_json).map_err(js_error)?;
    serde_json::to_string(&artifact).map_err(|error| js_error(error.into()))
}

fn initialize(peer_id: &str) -> DomainResult<String> {
    let library = Library::with_peer_id(parse_peer_id(peer_id)?)?;
    encode_snapshot(&library)
}

fn materialize(snapshot_base64: &str, peer_id: &str) -> DomainResult<String> {
    let library = restore(snapshot_base64, peer_id)?;
    serde_json::to_string(&browser_projection(library.canonical_projection()?))
        .map_err(DomainError::from)
}

#[allow(clippy::too_many_arguments)]
fn apply_local_mutation(
    snapshot_base64: &str,
    peer_id: &str,
    library_id: &str,
    device_id: &str,
    sequence: &str,
    created_at: &str,
    mutation_json: &str,
) -> DomainResult<String> {
    let sequence_number = parse_decimal_u64(sequence, "device sequence")?;
    if sequence_number == 0 || sequence_number == u64::MAX {
        return Err(DomainError::InvalidState(
            "device sequence must be between 1 and 18446744073709551614".into(),
        ));
    }
    let mutation: BrowserMutation = serde_json::from_str(mutation_json)?;
    let library = restore(snapshot_base64, peer_id)?;
    let before = library.version();
    let before_projection = library.canonical_projection()?;
    let sequence_text = format!("{sequence_number:020}");
    apply_one_mutation(
        &library,
        &before_projection,
        device_id,
        &sequence_text,
        mutation,
    )?;
    let envelope =
        library.export_envelope(&before, library_id, device_id, sequence_number, created_at)?;
    let result = MutationResult {
        snapshot: encode_snapshot(&library)?,
        projection: browser_projection(library.canonical_projection()?),
        envelope: serde_json::to_string(&envelope)?,
    };
    Ok(serde_json::to_string(&result)?)
}

fn apply_remote(
    snapshot_base64: &str,
    peer_id: &str,
    expected_library_id: &str,
    envelope_json_array: &str,
) -> DomainResult<String> {
    validate_uuid_v7(expected_library_id, "expected library ID")?;
    let encoded_envelopes: Vec<String> = serde_json::from_str(envelope_json_array)?;
    let envelopes = encoded_envelopes
        .iter()
        .map(|encoded| serde_json::from_str::<UpdateEnvelope>(encoded))
        .collect::<Result<Vec<_>, _>>()?;
    for envelope in &envelopes {
        envelope.validate_identity(expected_library_id, &envelope.path())?;
    }

    let mut unique = Vec::<(UpdateEnvelope, &str, Vec<usize>)>::new();
    let mut identities = std::collections::BTreeMap::<String, usize>::new();
    for (index, (encoded, envelope)) in encoded_envelopes
        .iter()
        .map(String::as_str)
        .zip(envelopes)
        .enumerate()
    {
        let path = envelope.path();
        if let Some(&unique_index) = identities.get(&path) {
            let (_, first_encoded, indices) = &mut unique[unique_index];
            if first_encoded.as_bytes() != encoded.as_bytes() {
                return Err(DomainError::InvalidState(format!(
                    "batch identity collision at {path}"
                )));
            }
            indices.push(index);
        } else {
            identities.insert(path, unique.len());
            unique.push((envelope, encoded, vec![index]));
        }
    }

    let library = restore(snapshot_base64, peer_id)?;
    let mut possibly_pending = Vec::new();
    for (index, (envelope, _, _)) in unique.iter().enumerate() {
        if library.import_envelope_has_pending(envelope)? {
            possibly_pending.push(index);
        }
    }

    // A predecessor may appear later in the same pull. Re-offer only batches
    // that were initially deferred so the browser persists the genuinely
    // unresolved tail, not a stale intermediate import status.
    let mut pending_indices = Vec::new();
    for index in possibly_pending {
        let (envelope, _, original_indices) = &unique[index];
        if library.import_envelope_has_pending(envelope)? {
            pending_indices.extend(original_indices);
        }
    }
    pending_indices.sort_unstable();

    let result = RemoteResult {
        snapshot: encode_snapshot(&library)?,
        projection: browser_projection(library.canonical_projection()?),
        pending_indices,
    };
    Ok(serde_json::to_string(&result)?)
}

fn apply_one_mutation(
    library: &Library,
    projection: &CanonicalProjection,
    device_id: &str,
    sequence: &str,
    mutation: BrowserMutation,
) -> DomainResult<()> {
    match mutation {
        BrowserMutation::Create {
            item_id,
            url,
            title,
            excerpt,
            favorite,
            language,
            saved_at,
            note,
            tags,
        } => {
            if projection.items.contains_key(&item_id) {
                return Err(DomainError::InvalidState(format!(
                    "item {item_id} already exists"
                )));
            }
            let operation_prefix = format!("{device_id}/{sequence}/mutation/{item_id}/create");
            library.create_item(
                &ItemSeed {
                    item_id,
                    url,
                    title: title.0,
                    excerpt: excerpt.0,
                    favorite,
                    language: language.0,
                    saved_at,
                    note: note.0.unwrap_or_default(),
                    tags,
                },
                &operation_prefix,
            )
        }
        BrowserMutation::Edit {
            item_id,
            url,
            title,
            excerpt,
            favorite,
            language,
            saved_at,
            note,
            expected_note,
            add_tags,
            remove_tags,
        } => apply_edit(
            library,
            projection,
            device_id,
            sequence,
            &item_id,
            url.0,
            title.0,
            excerpt.0,
            favorite.0,
            language.0,
            saved_at.0,
            note.0,
            expected_note.0,
            add_tags,
            remove_tags,
        ),
        BrowserMutation::Delete { item_id } => transition_item(
            library,
            projection,
            device_id,
            sequence,
            &item_id,
            LifecycleState::Deleted,
        ),
        BrowserMutation::Restore { item_id } => transition_item(
            library,
            projection,
            device_id,
            sequence,
            &item_id,
            LifecycleState::Active,
        ),
    }
}

#[allow(clippy::too_many_arguments)]
fn apply_edit(
    library: &Library,
    projection: &CanonicalProjection,
    device_id: &str,
    sequence: &str,
    item_id: &str,
    url: Option<String>,
    title: Option<TextUpdate>,
    excerpt: Option<TextUpdate>,
    favorite: Option<bool>,
    language: Option<TextUpdate>,
    saved_at: Option<i64>,
    note: Option<TextUpdate>,
    expected_note: Option<NullableText>,
    add_tags: Vec<String>,
    remove_tags: Vec<String>,
) -> DomainResult<()> {
    let current = projection
        .items
        .get(item_id)
        .ok_or_else(|| DomainError::InvalidState(format!("item {item_id} does not exist")))?;
    let has_non_note_changes = url.is_some()
        || title.is_some()
        || excerpt.is_some()
        || favorite.is_some()
        || language.is_some()
        || saved_at.is_some()
        || !add_tags.is_empty()
        || !remove_tags.is_empty();
    if !has_non_note_changes && note.is_none() {
        return Err(DomainError::InvalidState(
            "edit must include at least one change".into(),
        ));
    }

    let add_tags = add_tags.into_iter().collect::<BTreeSet<_>>();
    let remove_tags = remove_tags.into_iter().collect::<BTreeSet<_>>();
    if let Some(tag) = add_tags.intersection(&remove_tags).next() {
        return Err(DomainError::InvalidState(format!(
            "tag {tag:?} cannot be added and removed in one edit"
        )));
    }

    let prefix = format!("{device_id}/{sequence}/mutation/{item_id}");
    if let Some(url) = url {
        library.write_url(item_id, &format!("{prefix}/url"), &url)?;
    }
    if let Some(title) = title {
        library.write_title(item_id, &format!("{prefix}/title"), title.value())?;
    }
    if let Some(excerpt) = excerpt {
        library.write_excerpt(item_id, &format!("{prefix}/excerpt"), excerpt.value())?;
    }
    if let Some(favorite) = favorite {
        library.write_favorite(item_id, &format!("{prefix}/favorite"), favorite)?;
    }
    if let Some(language) = language {
        library.write_language(item_id, &format!("{prefix}/language"), language.value())?;
    }
    if let Some(saved_at) = saved_at {
        library.write_saved_at(item_id, &format!("{prefix}/saved-at"), saved_at)?;
    }
    if let Some(note) = note {
        if let Some(expected_note) = expected_note
            && expected_note.0.as_deref().unwrap_or_default() != current.note.as_str()
        {
            return Err(DomainError::InvalidState(
                "the note changed after this edit form opened".into(),
            ));
        }
        let replacement = note.value().unwrap_or_default();
        if replacement == current.note && !has_non_note_changes {
            return Err(DomainError::InvalidState(
                "edit does not change the item".into(),
            ));
        }
        if replacement != current.note {
            library.splice_note_utf16(
                item_id,
                0,
                current.note.encode_utf16().count(),
                replacement,
            )?;
        }
    }
    for tag in remove_tags {
        library.remove_tag(item_id, &tag)?;
    }
    for (index, tag) in add_tags.into_iter().enumerate() {
        library.add_tag(item_id, &tag, &format!("{prefix}/tag-add/{index:020}"))?;
    }
    Ok(())
}

fn transition_item(
    library: &Library,
    projection: &CanonicalProjection,
    device_id: &str,
    sequence: &str,
    item_id: &str,
    state: LifecycleState,
) -> DomainResult<()> {
    if !projection.items.contains_key(item_id) {
        return Err(DomainError::InvalidState(format!(
            "item {item_id} does not exist"
        )));
    }
    let prefix = format!("{device_id}/{sequence}/mutation/{item_id}");
    library.transition_lifecycle(item_id, &format!("{prefix}/lifecycle"), state)
}

impl TextUpdate {
    fn value(&self) -> Option<&str> {
        match self {
            Self::Set { value } => Some(value),
            Self::Clear => None,
        }
    }
}

fn restore(snapshot_base64: &str, peer_id: &str) -> DomainResult<Library> {
    let snapshot = STANDARD.decode(snapshot_base64)?;
    Library::from_snapshot(&snapshot, parse_peer_id(peer_id)?)
}

fn encode_snapshot(library: &Library) -> DomainResult<String> {
    Ok(STANDARD.encode(library.export_snapshot()?))
}

fn browser_projection(projection: CanonicalProjection) -> BrowserProjection {
    let mut items = projection
        .items
        .into_iter()
        .map(|(id, item)| {
            let mut tags = item.tags;
            tags.sort();
            BrowserItem {
                id,
                url: item.url.value,
                title: item.title.value,
                excerpt: item.excerpt.value,
                note: (!item.note.is_empty()).then_some(item.note),
                favorite: item.favorite.value,
                language: item.language.value,
                saved_at: item.saved_at.value,
                tags,
                state: match item.lifecycle.state {
                    LifecycleState::Active => "active",
                    LifecycleState::Deleted => "deleted",
                },
            }
        })
        .collect::<Vec<_>>();
    items.sort_by(|left, right| {
        right
            .saved_at
            .cmp(&left.saved_at)
            .then_with(|| left.id.cmp(&right.id))
    });
    BrowserProjection {
        schema_version: projection.schema_version,
        items,
    }
}

fn parse_decimal_u64(value: &str, label: &str) -> DomainResult<u64> {
    if value.is_empty() || !value.bytes().all(|byte| byte.is_ascii_digit()) {
        return Err(DomainError::InvalidState(format!(
            "{label} must be unsigned decimal text"
        )));
    }
    value.parse::<u64>().map_err(|_| {
        DomainError::InvalidState(format!("{label} is outside the unsigned 64-bit range"))
    })
}

fn parse_peer_id(value: &str) -> DomainResult<u64> {
    let peer_id = parse_decimal_u64(value, "peer ID")?;
    if peer_id == u64::MAX {
        return Err(DomainError::InvalidState(
            "peer ID uses Loro's reserved internal value".into(),
        ));
    }
    Ok(peer_id)
}

fn js_error(error: DomainError) -> JsValue {
    JsValue::from_str(&error.to_string())
}
