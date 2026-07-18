use std::collections::{BTreeMap, BTreeSet};

use serde::{Deserialize, Serialize};

use crate::{DomainError, DomainResult};

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
pub struct ScalarRevision<T> {
    pub parents: Vec<String>,
    pub value: T,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum LifecycleState {
    Active,
    Deleted,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
pub struct LifecycleRevision {
    pub generation: u64,
    pub parents: Vec<String>,
    pub state: LifecycleState,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
pub struct ScalarView<T> {
    pub value: T,
    pub winner: String,
    pub heads: Vec<String>,
    pub revisions: BTreeMap<String, ScalarRevision<T>>,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
pub struct LifecycleView {
    pub state: LifecycleState,
    pub generation: u64,
    pub heads: Vec<String>,
    pub revisions: BTreeMap<String, LifecycleRevision>,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
pub struct CanonicalItem {
    pub url: ScalarView<String>,
    pub title: ScalarView<Option<String>>,
    pub excerpt: ScalarView<Option<String>>,
    pub favorite: ScalarView<bool>,
    pub language: ScalarView<Option<String>>,
    pub saved_at: ScalarView<i64>,
    pub note: String,
    pub tags: Vec<String>,
    pub lifecycle: LifecycleView,
}

/// Explicit private-state projection used by the cross-runtime golden test.
/// No raw containers, unknown fields, transport timestamps, or envelope metadata leak in.
#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
pub struct CanonicalProjection {
    pub schema_version: u8,
    pub items: BTreeMap<String, CanonicalItem>,
}

pub(crate) fn causal_heads<T>(
    revisions: &BTreeMap<String, T>,
    parents: impl Fn(&T) -> &[String],
) -> Vec<String> {
    let referenced: BTreeSet<&str> = revisions
        .values()
        .flat_map(|revision| parents(revision).iter().map(String::as_str))
        .collect();
    revisions
        .keys()
        .filter(|revision| !referenced.contains(revision.as_str()))
        .cloned()
        .collect()
}

pub(crate) fn scalar_view<T: Clone>(
    revisions: BTreeMap<String, ScalarRevision<T>>,
) -> DomainResult<ScalarView<T>> {
    let heads = causal_heads(&revisions, |revision| &revision.parents);
    let winner = heads
        .last()
        .cloned()
        .ok_or_else(|| DomainError::InvalidState("scalar has no causal head".into()))?;
    let value = revisions
        .get(&winner)
        .ok_or_else(|| DomainError::InvalidState("scalar winner is missing".into()))?
        .value
        .clone();
    Ok(ScalarView {
        value,
        winner,
        heads,
        revisions,
    })
}

pub(crate) fn lifecycle_view(
    revisions: BTreeMap<String, LifecycleRevision>,
) -> DomainResult<LifecycleView> {
    let heads = causal_heads(&revisions, |revision| &revision.parents);
    if heads.is_empty() {
        return Err(DomainError::InvalidState(
            "lifecycle has no causal head".into(),
        ));
    }
    let head_revisions = heads
        .iter()
        .map(|head| {
            revisions
                .get(head)
                .ok_or_else(|| DomainError::InvalidState("lifecycle head is missing".into()))
        })
        .collect::<DomainResult<Vec<_>>>()?;
    // Delete wins whenever a restore did not observe every concurrent delete.
    let state = if head_revisions
        .iter()
        .any(|revision| revision.state == LifecycleState::Deleted)
    {
        LifecycleState::Deleted
    } else {
        LifecycleState::Active
    };
    let generation = head_revisions
        .iter()
        .map(|revision| revision.generation)
        .max()
        .unwrap_or(0);
    Ok(LifecycleView {
        state,
        generation,
        heads,
        revisions,
    })
}

#[cfg(test)]
mod tests {
    use super::{ScalarRevision, scalar_view};
    use std::collections::BTreeMap;

    #[test]
    fn concurrent_human_revision_wins_over_low_priority_enrichment_revision() {
        let base = "01900000-0000-7000-8000-000000000001/00000000000000000001/title";
        let enrichment = "!researchpocket-enrichment/01900000/title";
        let human = "01900000-0000-7000-8000-000000000002/00000000000000000001/title";
        let revisions = BTreeMap::from([
            (
                base.to_owned(),
                ScalarRevision {
                    parents: Vec::new(),
                    value: None::<String>,
                },
            ),
            (
                enrichment.to_owned(),
                ScalarRevision {
                    parents: vec![base.to_owned()],
                    value: Some("Fetched title".to_owned()),
                },
            ),
            (
                human.to_owned(),
                ScalarRevision {
                    parents: vec![base.to_owned()],
                    value: None,
                },
            ),
        ]);

        let view = scalar_view(revisions).expect("project concurrent scalar revisions");
        assert_eq!(view.heads, [enrichment, human]);
        assert_eq!(view.winner, human);
        assert_eq!(view.value, None);
    }
}
