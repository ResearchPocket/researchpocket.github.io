//! Zen documents: authored prose, lists, and todos as their own aggregate.
//!
//! A zen document reuses the entity primitives items are built from — causal
//! scalar registers, add-wins tag sets, lifecycle generations, and
//! character-level text — so concurrent prose edits and todo toggles merge
//! under semantics that are already proven, rather than a second set of rules.
//!
//! Structure is Markdown inside the body text. A checkbox toggle is therefore a
//! character splice, which is what lets two devices flip different boxes and
//! keep both.

use loro::{ExportMode, LoroDoc, VersionVector};
use serde::{Deserialize, Serialize};

use crate::document::{
    DomainError, DomainResult, add_entity_tag, entity_mut, entity_text_mut, loro_error,
    map_child, map_keys, project_scalar, project_tags, remove_entity_tag, text_child,
    transition_entity_lifecycle, write_entity_scalar,
};
use crate::identity::validate_uuid_v7;
use crate::projection::{LifecycleState, LifecycleView, ScalarView, lifecycle_view};
use crate::{LifecycleRevision, TextSplice};

const ZEN: &str = "zen";
const BODY: &str = "body";
const TITLE: &str = "title";
const CREATED_AT: &str = "created_at";
const SCALARS: &str = "scalars";
const TAGS: &str = "tags";
const LIFECYCLE: &str = "lifecycle";
const REVISIONS: &str = "revisions";

/// Largest body this build accepts, in UTF-8 bytes.
///
/// Raising it is a protocol decision, not a configuration knob: a larger body
/// changes what every replica must be able to hold and transport.
pub const MAX_ZEN_BODY_BYTES: usize = 256 * 1024;

/// Complete input for creating one zen document.
#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
pub struct ZenDocumentSeed {
    pub document_id: String,
    pub title: Option<String>,
    pub body: String,
    pub created_at: i64,
    pub tags: Vec<String>,
}

/// Everything a reader needs about one document, including its body.
#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
pub struct ZenDocumentView {
    pub document_id: String,
    pub title: ScalarView<Option<String>>,
    pub created_at: ScalarView<i64>,
    pub body: String,
    pub tags: Vec<String>,
    pub lifecycle: LifecycleView,
}

impl ZenDocumentView {
    pub fn summary(&self) -> ZenDocumentSummary {
        let (todo_total, todo_done) = count_todos(&self.body);
        ZenDocumentSummary {
            document_id: self.document_id.clone(),
            title: self.title.value.clone(),
            created_at: self.created_at.value,
            byte_length: self.body.len(),
            todo_total,
            todo_done,
            tags: self.tags.clone(),
            lifecycle_state: self.lifecycle.state,
        }
    }
}

/// List-shaped metadata that never carries body bytes.
///
/// The workspace index is built from these so opening it stays proportional to
/// the number of documents rather than their size.
#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
pub struct ZenDocumentSummary {
    pub document_id: String,
    pub title: Option<String>,
    pub created_at: i64,
    pub byte_length: usize,
    pub todo_total: usize,
    pub todo_done: usize,
    pub tags: Vec<String>,
    pub lifecycle_state: LifecycleState,
}

/// Counts GFM task-list items, and how many are checked.
///
/// Derived from the body rather than stored, so a hand-edited checkbox and a
/// clicked one are indistinguishable — there is no counter to fall out of step.
fn count_todos(body: &str) -> (usize, usize) {
    let mut total = 0;
    let mut done = 0;
    for line in body.lines() {
        let trimmed = line.trim_start();
        let Some(rest) = trimmed
            .strip_prefix("- ")
            .or_else(|| trimmed.strip_prefix("* "))
            .or_else(|| trimmed.strip_prefix("+ "))
        else {
            continue;
        };
        let rest = rest.trim_start();
        let checked = match rest.as_bytes() {
            [b'[', mark, b']', ..] => match mark {
                b' ' => Some(false),
                b'x' | b'X' => Some(true),
                _ => None,
            },
            _ => None,
        };
        if let Some(checked) = checked {
            total += 1;
            if checked {
                done += 1;
            }
        }
    }
    (total, done)
}

/// One zen document's replica.
pub struct ZenAggregate {
    document_id: String,
    doc: LoroDoc,
}

impl ZenAggregate {
    pub fn create(
        seed: &ZenDocumentSeed,
        operation_prefix: &str,
        peer_id: u64,
    ) -> DomainResult<Self> {
        validate_uuid_v7(&seed.document_id, "zen document ID")?;
        validate_body(&seed.body)?;
        if operation_prefix.trim().is_empty() {
            return Err(DomainError::InvalidState(
                "operation prefix cannot be blank".into(),
            ));
        }
        let doc = LoroDoc::new();
        doc.set_peer_id(peer_id).map_err(loro_error)?;
        let aggregate = Self {
            document_id: seed.document_id.clone(),
            doc,
        };

        let entity = aggregate.entity()?;
        entity_text_mut(&entity, BODY)?
            .splice_utf16(0, 0, &seed.body)
            .map_err(loro_error)?;
        write_entity_scalar(
            &entity,
            TITLE,
            &format!("{operation_prefix}/{TITLE}"),
            seed.title.clone(),
        )?;
        write_entity_scalar(
            &entity,
            CREATED_AT,
            &format!("{operation_prefix}/{CREATED_AT}"),
            seed.created_at,
        )?;
        entity.ensure_mergeable_map(TAGS).map_err(loro_error)?;
        for (index, tag) in seed.tags.iter().enumerate() {
            add_entity_tag(&entity, tag, &format!("{operation_prefix}/tag/{index:020}"))?;
        }
        transition_entity_lifecycle(
            &entity,
            &format!("{operation_prefix}/{LIFECYCLE}"),
            LifecycleState::Active,
        )?;
        Ok(aggregate)
    }

    pub fn from_snapshot(
        document_id: &str,
        snapshot: &[u8],
        peer_id: u64,
    ) -> DomainResult<Self> {
        validate_uuid_v7(document_id, "zen document ID")?;
        let doc = LoroDoc::new();
        doc.set_peer_id(peer_id).map_err(loro_error)?;
        doc.import(snapshot).map_err(loro_error)?;
        let aggregate = Self {
            document_id: document_id.to_owned(),
            doc,
        };
        let present = map_keys(&aggregate.doc.get_map(ZEN));
        if present != [document_id.to_owned()] {
            return Err(DomainError::InvalidState(
                "zen snapshot does not contain exactly its declared document".into(),
            ));
        }
        Ok(aggregate)
    }

    pub fn document_id(&self) -> &str {
        &self.document_id
    }

    pub fn version(&self) -> VersionVector {
        self.doc.oplog_vv()
    }

    pub fn export_snapshot(&self) -> DomainResult<Vec<u8>> {
        self.doc.export(ExportMode::Snapshot).map_err(loro_error)
    }

    pub fn export_update(&self, from: &VersionVector) -> DomainResult<Vec<u8>> {
        self.doc
            .export(ExportMode::updates(from))
            .map_err(loro_error)
    }

    pub fn import_update(&self, update: &[u8]) -> DomainResult<()> {
        self.doc.import(update).map_err(loro_error).map(|_| ())
    }

    pub fn write_title(&self, revision_id: &str, title: Option<&str>) -> DomainResult<()> {
        write_entity_scalar(
            &self.entity()?,
            TITLE,
            revision_id,
            title.map(str::to_owned),
        )
    }

    pub fn add_tag(&self, tag: &str, add_dot: &str) -> DomainResult<()> {
        add_entity_tag(&self.entity()?, tag, add_dot)
    }

    pub fn remove_tag(&self, tag: &str) -> DomainResult<()> {
        remove_entity_tag(&self.entity()?, tag)
    }

    pub fn transition_lifecycle(
        &self,
        revision_id: &str,
        state: LifecycleState,
    ) -> DomainResult<()> {
        transition_entity_lifecycle(&self.entity()?, revision_id, state)
    }

    pub fn splice_body_utf16(
        &self,
        position: usize,
        length: usize,
        replacement: &str,
    ) -> DomainResult<()> {
        entity_text_mut(&self.entity()?, BODY)?
            .splice_utf16(position, length, replacement)
            .map_err(loro_error)
    }

    /// Rewrites the body by splicing only the range that actually changed.
    ///
    /// Replacing the whole text would make two devices editing different
    /// sections conflict over the entire document instead of merging, and would
    /// carry the whole body in every update.
    pub fn set_body(&self, replacement: &str) -> DomainResult<()> {
        validate_body(replacement)?;
        let current = self.body()?;
        let Some(splice) = TextSplice::between(&current, replacement) else {
            return Ok(());
        };
        self.splice_body_utf16(splice.position, splice.length, &splice.insert)
    }

    pub fn body(&self) -> DomainResult<String> {
        Ok(text_child(&self.entity()?, BODY)?.to_string())
    }

    pub fn view(&self) -> DomainResult<ZenDocumentView> {
        let entity = map_child(&self.doc.get_map(ZEN), &self.document_id)?;
        let scalars = map_child(&entity, SCALARS)?;
        let lifecycle = map_child(&entity, LIFECYCLE)?;
        Ok(ZenDocumentView {
            document_id: self.document_id.clone(),
            title: project_scalar::<Option<String>>(&scalars, TITLE)?,
            created_at: project_scalar::<i64>(&scalars, CREATED_AT)?,
            body: text_child(&entity, BODY)?.to_string(),
            tags: project_tags(map_child(&entity, TAGS)?)?,
            lifecycle: lifecycle_view(crate::document::read_entity_records::<
                LifecycleRevision,
            >(&map_child(&lifecycle, REVISIONS)?)?)?,
        })
    }

    fn entity(&self) -> DomainResult<loro::LoroMap> {
        entity_mut(&self.doc, ZEN, &self.document_id)
    }
}

fn validate_body(body: &str) -> DomainResult<()> {
    if body.len() > MAX_ZEN_BODY_BYTES {
        return Err(DomainError::InvalidState(format!(
            "zen document body is {} bytes, over the {MAX_ZEN_BODY_BYTES} byte bound",
            body.len()
        )));
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    const DOCUMENT: &str = "0197f2b5-93d7-7ad4-8c67-21e98f0c7341";

    fn seed() -> ZenDocumentSeed {
        ZenDocumentSeed {
            document_id: DOCUMENT.to_owned(),
            title: Some("Today".to_owned()),
            body: "- [x] Ship it\n- [ ] Review #132\n\nGrocery run.".to_owned(),
            created_at: 1_700_000_000,
            tags: vec!["reading".to_owned()],
        }
    }

    /// Concurrent toggles and prose edits must both survive, because structure
    /// lives in the text rather than in a per-todo register.
    #[test]
    fn concurrent_todo_toggle_and_prose_edit_both_land() {
        let alice = ZenAggregate::create(&seed(), "alice/1", 11).expect("create");
        let snapshot = alice.export_snapshot().expect("snapshot");
        let bob = ZenAggregate::from_snapshot(DOCUMENT, &snapshot, 22).expect("replica");

        let alice_before = alice.version();
        let bob_before = bob.version();
        alice
            .set_body("- [x] Ship it\n- [x] Review #132\n\nGrocery run.")
            .expect("toggle the second todo");
        bob.set_body("- [x] Ship it\n- [ ] Review #132\n\nGrocery run after standup.")
            .expect("extend the prose");

        let from_alice = alice.export_update(&alice_before).expect("alice update");
        let from_bob = bob.export_update(&bob_before).expect("bob update");
        alice.import_update(&from_bob).expect("apply bob");
        bob.import_update(&from_alice).expect("apply alice");

        let merged = alice.body().expect("merged body");
        assert_eq!(merged, bob.body().expect("bob body"), "replicas converge");
        assert!(merged.contains("- [x] Review #132"), "toggle survives");
        assert!(merged.contains("after standup"), "prose edit survives");

        let summary = alice.view().expect("view").summary();
        assert_eq!((summary.todo_total, summary.todo_done), (2, 2));
        assert_eq!(summary.title.as_deref(), Some("Today"));
        assert_eq!(summary.tags, ["reading"]);
    }

    #[test]
    fn a_body_over_the_bound_is_refused() {
        let mut oversized = seed();
        oversized.body = "x".repeat(MAX_ZEN_BODY_BYTES + 1);
        assert!(ZenAggregate::create(&oversized, "alice/1", 11).is_err());

        let aggregate = ZenAggregate::create(&seed(), "alice/1", 11).expect("create");
        assert!(
            aggregate
                .set_body(&"x".repeat(MAX_ZEN_BODY_BYTES + 1))
                .is_err()
        );
        assert!(
            aggregate.body().expect("body").contains("Ship it"),
            "a refused write leaves the document untouched"
        );
    }
}
