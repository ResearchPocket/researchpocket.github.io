use chrono::{DateTime, Duration, SecondsFormat, Utc};
use research_domain::{CanonicalItem, Library, LifecycleState};
use sqlx::{FromRow, Row, SqliteConnection};
use uuid::Uuid;

use crate::mutation::apply_item_mutation;
use crate::store::{fresh_peer_id, now_rfc3339, sha256_hex};
use crate::{
    EnrichmentApplyResult, EnrichmentCandidates, EnrichmentClaim, EnrichmentJob,
    EnrichmentProvider, EnrichmentQueueCounts, EnrichmentStatus, StoreError, StoreResult,
    StoredItem, V2Store,
};

pub const ENRICHMENT_MAX_ATTEMPTS: u64 = 5;

const RETRY_DELAYS_SECONDS: [i64; 4] = [60, 300, 1_800, 7_200];
const ENRICHMENT_LEASE_SECONDS: i64 = 120;
const ENRICHMENT_REVISION_PREFIX: &str = "!researchpocket-enrichment";

impl V2Store {
    pub async fn queue_item_enrichment(
        &self,
        item_id: &str,
        provider: EnrichmentProvider,
    ) -> StoreResult<EnrichmentJob> {
        self.queue_item_enrichment_with_options(item_id, provider, false)
            .await
    }

    pub async fn queue_item_enrichment_replacing_excerpt(
        &self,
        item_id: &str,
        provider: EnrichmentProvider,
    ) -> StoreResult<EnrichmentJob> {
        self.queue_item_enrichment_with_options(item_id, provider, true)
            .await
    }

    async fn queue_item_enrichment_with_options(
        &self,
        item_id: &str,
        provider: EnrichmentProvider,
        replace_excerpt: bool,
    ) -> StoreResult<EnrichmentJob> {
        let mut connection = self.pool.acquire().await?;
        sqlx::query("BEGIN IMMEDIATE")
            .execute(&mut *connection)
            .await?;
        let result = async {
            queue_enrichment_on_connection_with_options(
                &mut connection,
                item_id,
                provider,
                replace_excerpt,
            )
            .await?;
            required_enrichment_job(&mut connection, item_id).await
        }
        .await;
        finish_transaction(&mut connection, result).await
    }

    pub async fn enrichment_job(&self, item_id: &str) -> StoreResult<Option<EnrichmentJob>> {
        let mut connection = self.pool.acquire().await?;
        optional_enrichment_job(&mut connection, item_id).await
    }

    pub async fn claim_next_due_enrichment_job(&self) -> StoreResult<Option<EnrichmentClaim>> {
        let mut connection = self.pool.acquire().await?;
        sqlx::query("BEGIN IMMEDIATE")
            .execute(&mut *connection)
            .await?;
        let result = async {
            let now = now_rfc3339();
            let item_id = sqlx::query_scalar::<_, String>(
                "SELECT item_id FROM item_enrichment_jobs \
                 WHERE (status IN ('pending', 'retry') AND next_attempt_at <= ?) \
                    OR (status = 'in_progress' AND lease_expires_at <= ?) \
                 ORDER BY COALESCE(next_attempt_at, lease_expires_at) ASC, \
                          queued_at ASC, item_id ASC LIMIT 1",
            )
            .bind(&now)
            .bind(&now)
            .fetch_optional(&mut *connection)
            .await?;
            match item_id {
                Some(item_id) => claim_on_connection(&mut connection, &item_id, &now)
                    .await
                    .map(Some),
                None => Ok(None),
            }
        }
        .await;
        finish_transaction(&mut connection, result).await
    }

    pub async fn claim_item_enrichment(&self, item_id: &str) -> StoreResult<EnrichmentClaim> {
        let mut connection = self.pool.acquire().await?;
        sqlx::query("BEGIN IMMEDIATE")
            .execute(&mut *connection)
            .await?;
        let result = async {
            required_enrichment_job(&mut connection, item_id).await?;
            claim_on_connection(&mut connection, item_id, &now_rfc3339()).await
        }
        .await;
        finish_transaction(&mut connection, result).await
    }

    pub async fn enrichment_queue_counts(&self) -> StoreResult<EnrichmentQueueCounts> {
        let rows = sqlx::query(
            "SELECT status, COUNT(*) AS count FROM item_enrichment_jobs GROUP BY status",
        )
        .fetch_all(&self.pool)
        .await?;
        let mut counts = EnrichmentQueueCounts::default();
        for row in rows {
            let status: String = row.try_get("status")?;
            let count: i64 = row.try_get("count")?;
            let count = u64::try_from(count).map_err(|_| {
                StoreError::InvalidStore("invalid enrichment queue count".into())
            })?;
            match status.as_str() {
                "pending" => counts.pending = count,
                "retry" => counts.retrying = count,
                "in_progress" => counts.in_progress = count,
                "succeeded" => counts.succeeded = count,
                "failed" => counts.failed = count,
                "skipped" => counts.skipped = count,
                _ => {
                    return Err(StoreError::InvalidStore(format!(
                        "invalid enrichment status {status:?}"
                    )));
                }
            }
        }
        Ok(counts)
    }

    pub async fn apply_item_enrichment(
        &self,
        item_id: &str,
        lease_token: &str,
        expected_url: &str,
        expected_state: &str,
        candidates: EnrichmentCandidates,
    ) -> StoreResult<EnrichmentApplyResult> {
        let mut connection = self.pool.acquire().await?;
        sqlx::query("BEGIN IMMEDIATE")
            .execute(&mut *connection)
            .await?;
        let result = apply_enrichment_on_connection(
            &mut connection,
            item_id,
            lease_token,
            expected_url,
            expected_state,
            candidates,
        )
        .await;
        finish_transaction(&mut connection, result).await
    }

    pub async fn record_enrichment_failure(
        &self,
        item_id: &str,
        lease_token: &str,
        error_kind: &str,
    ) -> StoreResult<EnrichmentJob> {
        validate_error_kind(error_kind)?;
        let mut connection = self.pool.acquire().await?;
        sqlx::query("BEGIN IMMEDIATE")
            .execute(&mut *connection)
            .await?;
        let result =
            record_failure_on_connection(&mut connection, item_id, lease_token, error_kind)
                .await;
        finish_transaction(&mut connection, result).await
    }
}

#[derive(Clone)]
struct EnrichmentTargets {
    title_revision: Option<String>,
    excerpt_revision: Option<String>,
    language_revision: Option<String>,
}

pub(crate) async fn queue_enrichment_on_connection(
    connection: &mut SqliteConnection,
    item_id: &str,
    provider: EnrichmentProvider,
) -> StoreResult<()> {
    queue_enrichment_on_connection_with_options(connection, item_id, provider, false).await
}

async fn queue_enrichment_on_connection_with_options(
    connection: &mut SqliteConnection,
    item_id: &str,
    provider: EnrichmentProvider,
    replace_excerpt: bool,
) -> StoreResult<()> {
    let item = canonical_item_from_connection(connection, item_id).await?;
    let targets = EnrichmentTargets {
        title_revision: (item.title.value.is_none() && item.title.revisions.len() == 1)
            .then(|| item.title.winner.clone()),
        excerpt_revision: (replace_excerpt
            || (item.excerpt.value.is_none() && item.excerpt.revisions.len() == 1)
            || enrichment_owned_revision(&item.excerpt.winner))
        .then(|| item.excerpt.winner.clone()),
        language_revision: (item.language.value.is_none()
            && item.language.revisions.len() == 1)
            .then(|| item.language.winner.clone()),
    };
    let now = now_rfc3339();
    let has_targets = targets.title_revision.is_some()
        || targets.excerpt_revision.is_some()
        || targets.language_revision.is_some();
    let status = if has_targets { "pending" } else { "skipped" };
    let next_attempt_at = has_targets.then_some(now.as_str());
    let completed_at = (!has_targets).then_some(now.as_str());
    let updated = sqlx::query(
        "INSERT INTO item_enrichment_jobs \
         (item_id, provider, status, attempts, target_title, target_excerpt, target_language, \
          expected_title_revision, expected_excerpt_revision, expected_language_revision, \
          queued_at, updated_at, next_attempt_at, last_attempt_at, completed_at, lease_token, \
          lease_expires_at, last_error_kind) \
         VALUES (?, ?, ?, 0, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, NULL, NULL, NULL) \
         ON CONFLICT(item_id) DO UPDATE SET \
          provider = excluded.provider, status = excluded.status, attempts = 0, \
          target_title = excluded.target_title, target_excerpt = excluded.target_excerpt, \
          target_language = excluded.target_language, \
          expected_title_revision = excluded.expected_title_revision, \
          expected_excerpt_revision = excluded.expected_excerpt_revision, \
          expected_language_revision = excluded.expected_language_revision, \
          queued_at = excluded.queued_at, updated_at = excluded.updated_at, \
          next_attempt_at = excluded.next_attempt_at, last_attempt_at = NULL, \
          completed_at = excluded.completed_at, lease_token = NULL, lease_expires_at = NULL, \
          last_error_kind = NULL \
         WHERE item_enrichment_jobs.status != 'in_progress'",
    )
    .bind(item_id)
    .bind(provider.as_str())
    .bind(status)
    .bind(targets.title_revision.is_some())
    .bind(targets.excerpt_revision.is_some())
    .bind(targets.language_revision.is_some())
    .bind(&targets.title_revision)
    .bind(&targets.excerpt_revision)
    .bind(&targets.language_revision)
    .bind(&now)
    .bind(&now)
    .bind(next_attempt_at)
    .bind(completed_at)
    .execute(&mut *connection)
    .await?
    .rows_affected();
    if updated == 0 {
        return Err(StoreError::EnrichmentJobNotPending(item_id.to_owned()));
    }
    Ok(())
}

async fn apply_enrichment_on_connection(
    connection: &mut SqliteConnection,
    item_id: &str,
    lease_token: &str,
    expected_url: &str,
    expected_state: &str,
    candidates: EnrichmentCandidates,
) -> StoreResult<EnrichmentApplyResult> {
    let current_job = required_claimed_enrichment_job(connection, item_id, lease_token).await?;
    let current_item = canonical_item_from_connection(connection, item_id).await?;
    let current_state = lifecycle_state_name(current_item.lifecycle.state);
    if current_item.url.value != expected_url || current_state != expected_state {
        return Err(StoreError::StaleEdit);
    }

    let title = candidate(candidates.title).filter(|_| {
        current_item.title.value.is_none()
            && current_job.expected_title_revision.as_deref()
                == Some(current_item.title.winner.as_str())
    });
    let excerpt = candidate(candidates.excerpt).filter(|_| {
        current_job.expected_excerpt_revision.as_deref()
            == Some(current_item.excerpt.winner.as_str())
    });
    let language = candidate(candidates.language).filter(|_| {
        current_item.language.value.is_none()
            && current_job.expected_language_revision.as_deref()
                == Some(current_item.language.winner.as_str())
    });
    let applied_title = title.is_some();
    let applied_excerpt = excerpt.is_some();
    let applied_language = language.is_some();
    let applied_any = applied_title || applied_excerpt || applied_language;

    let item = if applied_any {
        let mutation_item_id = item_id.to_owned();
        let expected_title_revision = current_job.expected_title_revision.clone();
        let expected_excerpt_revision = current_job.expected_excerpt_revision.clone();
        let expected_language_revision = current_job.expected_language_revision.clone();
        apply_item_mutation(connection, item_id, move |library, projection, prefix| {
            let item = projection
                .items
                .get(&mutation_item_id)
                .ok_or_else(|| StoreError::ItemNotFound(mutation_item_id.clone()))?;
            if let Some(title) = &title {
                if item.title.value.is_some()
                    || expected_title_revision.as_deref() != Some(item.title.winner.as_str())
                {
                    return Err(StoreError::StaleEdit);
                }
                library.write_title(
                    &mutation_item_id,
                    &enrichment_revision_id(prefix, "title"),
                    Some(title),
                )?;
            }
            if let Some(excerpt) = &excerpt {
                if expected_excerpt_revision.as_deref() != Some(item.excerpt.winner.as_str()) {
                    return Err(StoreError::StaleEdit);
                }
                library.write_excerpt(
                    &mutation_item_id,
                    &enrichment_revision_id(prefix, "excerpt"),
                    Some(excerpt),
                )?;
            }
            if let Some(language) = &language {
                if item.language.value.is_some()
                    || expected_language_revision.as_deref()
                        != Some(item.language.winner.as_str())
                {
                    return Err(StoreError::StaleEdit);
                }
                library.write_language(
                    &mutation_item_id,
                    &enrichment_revision_id(prefix, "language"),
                    Some(language),
                )?;
            }
            Ok(())
        })
        .await?
    } else {
        stored_item_from_connection(connection, item_id).await?
    };

    let attempts = current_job
        .job
        .attempts
        .checked_add(1)
        .ok_or(StoreError::NumericRange("enrichment attempts"))?;
    let attempts =
        i64::try_from(attempts).map_err(|_| StoreError::NumericRange("enrichment attempts"))?;
    let now = now_rfc3339();
    let status = if applied_any { "succeeded" } else { "skipped" };
    sqlx::query(
        "UPDATE item_enrichment_jobs SET status = ?, attempts = ?, updated_at = ?, \
         next_attempt_at = NULL, last_attempt_at = ?, completed_at = ?, last_error_kind = NULL \
         , lease_token = NULL, lease_expires_at = NULL \
         WHERE item_id = ? AND status = 'in_progress' AND lease_token = ?",
    )
    .bind(status)
    .bind(attempts)
    .bind(&now)
    .bind(&now)
    .bind(&now)
    .bind(item_id)
    .bind(lease_token)
    .execute(&mut *connection)
    .await?;
    let job = required_enrichment_job(connection, item_id).await?;

    Ok(EnrichmentApplyResult {
        item,
        job,
        applied_title,
        applied_excerpt,
        applied_language,
    })
}

async fn record_failure_on_connection(
    connection: &mut SqliteConnection,
    item_id: &str,
    lease_token: &str,
    error_kind: &str,
) -> StoreResult<EnrichmentJob> {
    let current_job = required_claimed_enrichment_job(connection, item_id, lease_token).await?;
    let attempts = current_job
        .job
        .attempts
        .checked_add(1)
        .ok_or(StoreError::NumericRange("enrichment attempts"))?;
    let terminal = attempts >= ENRICHMENT_MAX_ATTEMPTS;
    let now = Utc::now();
    let now_text = timestamp(now);
    let (status, next_attempt_at, completed_at) = if terminal {
        ("failed", None, Some(now_text.clone()))
    } else {
        let retry_index = usize::try_from(attempts - 1)
            .map_err(|_| StoreError::NumericRange("enrichment attempts"))?;
        let delay = RETRY_DELAYS_SECONDS
            .get(retry_index)
            .copied()
            .ok_or(StoreError::NumericRange("enrichment retry delay"))?;
        (
            "retry",
            Some(timestamp(now + Duration::seconds(delay))),
            None,
        )
    };
    let attempts =
        i64::try_from(attempts).map_err(|_| StoreError::NumericRange("enrichment attempts"))?;
    sqlx::query(
        "UPDATE item_enrichment_jobs SET status = ?, attempts = ?, updated_at = ?, \
         next_attempt_at = ?, last_attempt_at = ?, completed_at = ?, last_error_kind = ? \
         , lease_token = NULL, lease_expires_at = NULL \
         WHERE item_id = ? AND status = 'in_progress' AND lease_token = ?",
    )
    .bind(status)
    .bind(attempts)
    .bind(&now_text)
    .bind(next_attempt_at)
    .bind(&now_text)
    .bind(completed_at)
    .bind(error_kind)
    .bind(item_id)
    .bind(lease_token)
    .execute(&mut *connection)
    .await?;
    required_enrichment_job(connection, item_id).await
}

async fn stored_item_from_connection(
    connection: &mut SqliteConnection,
    item_id: &str,
) -> StoreResult<StoredItem> {
    let row = sqlx::query(
        "SELECT url, title, excerpt, favorite, language, saved_at, note, lifecycle_state \
         FROM items WHERE item_id = ?",
    )
    .bind(item_id)
    .fetch_optional(&mut *connection)
    .await?
    .ok_or_else(|| StoreError::ItemNotFound(item_id.to_owned()))?;
    let saved_at: i64 = row.try_get("saved_at")?;
    let saved_at = DateTime::<Utc>::from_timestamp(saved_at, 0)
        .ok_or_else(|| StoreError::InvalidStore("an item has an invalid timestamp".into()))?
        .to_rfc3339_opts(SecondsFormat::Secs, true);
    let note: String = row.try_get("note")?;
    let tags = sqlx::query_scalar::<_, String>(
        "SELECT tag FROM item_tags WHERE item_id = ? ORDER BY tag ASC",
    )
    .bind(item_id)
    .fetch_all(&mut *connection)
    .await?;
    Ok(StoredItem {
        id: item_id.to_owned(),
        url: row.try_get("url")?,
        title: row.try_get("title")?,
        excerpt: row.try_get("excerpt")?,
        note: (!note.is_empty()).then_some(note),
        favorite: row.try_get("favorite")?,
        language: row.try_get("language")?,
        saved_at,
        tags,
        state: row.try_get("lifecycle_state")?,
    })
}

async fn claim_on_connection(
    connection: &mut SqliteConnection,
    item_id: &str,
    now: &str,
) -> StoreResult<EnrichmentClaim> {
    let current = required_enrichment_job_record(connection, item_id).await?;
    let claimable = matches!(
        current.job.status,
        EnrichmentStatus::Pending | EnrichmentStatus::Retry
    ) || (current.job.status == EnrichmentStatus::InProgress
        && current
            .lease_expires_at
            .as_deref()
            .is_some_and(|expires_at| expires_at <= now));
    if !claimable {
        return Err(StoreError::EnrichmentJobNotPending(item_id.to_owned()));
    }

    let lease_token = Uuid::now_v7().to_string();
    let lease_expires_at = timestamp(Utc::now() + Duration::seconds(ENRICHMENT_LEASE_SECONDS));
    sqlx::query(
        "UPDATE item_enrichment_jobs SET status = 'in_progress', updated_at = ?, \
         next_attempt_at = NULL, lease_token = ?, lease_expires_at = ? WHERE item_id = ?",
    )
    .bind(now)
    .bind(&lease_token)
    .bind(&lease_expires_at)
    .bind(item_id)
    .execute(&mut *connection)
    .await?;
    let job = required_enrichment_job(connection, item_id).await?;
    Ok(EnrichmentClaim { job, lease_token })
}

async fn required_claimed_enrichment_job(
    connection: &mut SqliteConnection,
    item_id: &str,
    lease_token: &str,
) -> StoreResult<EnrichmentJobRecord> {
    let record = required_enrichment_job_record(connection, item_id).await?;
    if record.job.status != EnrichmentStatus::InProgress
        || record.lease_token.as_deref() != Some(lease_token)
    {
        return Err(StoreError::EnrichmentJobNotPending(item_id.to_owned()));
    }
    Ok(record)
}

async fn required_enrichment_job(
    connection: &mut SqliteConnection,
    item_id: &str,
) -> StoreResult<EnrichmentJob> {
    optional_enrichment_job_record(connection, item_id)
        .await?
        .map(|record| record.job)
        .ok_or_else(|| StoreError::EnrichmentJobNotFound(item_id.to_owned()))
}

async fn optional_enrichment_job(
    connection: &mut SqliteConnection,
    item_id: &str,
) -> StoreResult<Option<EnrichmentJob>> {
    Ok(optional_enrichment_job_record(connection, item_id)
        .await?
        .map(|record| record.job))
}

async fn required_enrichment_job_record(
    connection: &mut SqliteConnection,
    item_id: &str,
) -> StoreResult<EnrichmentJobRecord> {
    optional_enrichment_job_record(connection, item_id)
        .await?
        .ok_or_else(|| StoreError::EnrichmentJobNotFound(item_id.to_owned()))
}

async fn optional_enrichment_job_record(
    connection: &mut SqliteConnection,
    item_id: &str,
) -> StoreResult<Option<EnrichmentJobRecord>> {
    sqlx::query_as::<_, EnrichmentJobRow>(
        "SELECT item_id, provider, status, attempts, target_title, target_excerpt, \
         target_language, expected_title_revision, expected_excerpt_revision, \
         expected_language_revision, queued_at, updated_at, next_attempt_at, last_attempt_at, \
         completed_at, lease_token, lease_expires_at, last_error_kind \
         FROM item_enrichment_jobs WHERE item_id = ?",
    )
    .bind(item_id)
    .fetch_optional(&mut *connection)
    .await?
    .map(EnrichmentJobRecord::try_from)
    .transpose()
}

async fn canonical_item_from_connection(
    connection: &mut SqliteConnection,
    item_id: &str,
) -> StoreResult<CanonicalItem> {
    let state = sqlx::query(
        "SELECT snapshot, snapshot_sha256 FROM canonical_state WHERE singleton = 1",
    )
    .fetch_one(&mut *connection)
    .await?;
    let snapshot: Vec<u8> = state.try_get("snapshot")?;
    let expected_sha256: String = state.try_get("snapshot_sha256")?;
    if sha256_hex(&snapshot) != expected_sha256 {
        return Err(StoreError::InvalidStore(
            "canonical snapshot checksum mismatch".into(),
        ));
    }
    Library::from_snapshot(&snapshot, fresh_peer_id())?
        .canonical_projection()?
        .items
        .get(item_id)
        .cloned()
        .ok_or_else(|| StoreError::ItemNotFound(item_id.to_owned()))
}

async fn finish_transaction<T>(
    connection: &mut SqliteConnection,
    result: StoreResult<T>,
) -> StoreResult<T> {
    match result {
        Ok(value) => {
            sqlx::query("COMMIT").execute(&mut *connection).await?;
            Ok(value)
        }
        Err(error) => {
            let _ = sqlx::query("ROLLBACK").execute(&mut *connection).await;
            Err(error)
        }
    }
}

fn candidate(value: Option<String>) -> Option<String> {
    value.filter(|value| !value.trim().is_empty())
}

fn enrichment_revision_id(operation_prefix: &str, field: &str) -> String {
    // `!` sorts before every app-generated UUID revision ID. Existing V2 clients therefore
    // deterministically prefer a concurrent human revision without changing the CRDT schema.
    format!("{ENRICHMENT_REVISION_PREFIX}/{operation_prefix}/{field}")
}

fn enrichment_owned_revision(revision_id: &str) -> bool {
    revision_id.starts_with(ENRICHMENT_REVISION_PREFIX)
        && revision_id.as_bytes().get(ENRICHMENT_REVISION_PREFIX.len()) == Some(&b'/')
}

fn lifecycle_state_name(state: LifecycleState) -> &'static str {
    match state {
        LifecycleState::Active => "active",
        LifecycleState::Deleted => "deleted",
    }
}

fn validate_error_kind(value: &str) -> StoreResult<()> {
    if value.is_empty()
        || value.len() > 64
        || !value
            .bytes()
            .all(|byte| byte.is_ascii_lowercase() || byte.is_ascii_digit() || byte == b'_')
    {
        return Err(StoreError::InvalidInput(
            "enrichment error kind must be 1-64 lowercase ASCII letters, digits, or underscores"
                .into(),
        ));
    }
    Ok(())
}

fn timestamp(value: DateTime<Utc>) -> String {
    value.to_rfc3339_opts(SecondsFormat::Millis, true)
}

impl EnrichmentProvider {
    fn as_str(self) -> &'static str {
        match self {
            Self::Direct => "direct",
            Self::Firecrawl => "firecrawl",
        }
    }

    fn from_store(value: &str) -> StoreResult<Self> {
        match value {
            "direct" => Ok(Self::Direct),
            "firecrawl" => Ok(Self::Firecrawl),
            _ => Err(StoreError::InvalidStore(format!(
                "invalid enrichment provider {value:?}"
            ))),
        }
    }
}

impl EnrichmentStatus {
    fn from_store(value: &str) -> StoreResult<Self> {
        match value {
            "pending" => Ok(Self::Pending),
            "retry" => Ok(Self::Retry),
            "in_progress" => Ok(Self::InProgress),
            "succeeded" => Ok(Self::Succeeded),
            "failed" => Ok(Self::Failed),
            "skipped" => Ok(Self::Skipped),
            _ => Err(StoreError::InvalidStore(format!(
                "invalid enrichment status {value:?}"
            ))),
        }
    }
}

#[derive(FromRow)]
struct EnrichmentJobRow {
    item_id: String,
    provider: String,
    status: String,
    attempts: i64,
    target_title: bool,
    target_excerpt: bool,
    target_language: bool,
    expected_title_revision: Option<String>,
    expected_excerpt_revision: Option<String>,
    expected_language_revision: Option<String>,
    queued_at: String,
    updated_at: String,
    next_attempt_at: Option<String>,
    last_attempt_at: Option<String>,
    completed_at: Option<String>,
    lease_token: Option<String>,
    lease_expires_at: Option<String>,
    last_error_kind: Option<String>,
}

struct EnrichmentJobRecord {
    job: EnrichmentJob,
    expected_title_revision: Option<String>,
    expected_excerpt_revision: Option<String>,
    expected_language_revision: Option<String>,
    lease_token: Option<String>,
    lease_expires_at: Option<String>,
}

impl TryFrom<EnrichmentJobRow> for EnrichmentJobRecord {
    type Error = StoreError;

    fn try_from(row: EnrichmentJobRow) -> Result<Self, Self::Error> {
        let status = EnrichmentStatus::from_store(&row.status)?;
        if (status == EnrichmentStatus::InProgress)
            != (row.lease_token.is_some() && row.lease_expires_at.is_some())
        {
            return Err(StoreError::InvalidStore(
                "invalid enrichment lease state".into(),
            ));
        }
        Ok(Self {
            job: EnrichmentJob {
                item_id: row.item_id,
                provider: EnrichmentProvider::from_store(&row.provider)?,
                status,
                attempts: u64::try_from(row.attempts).map_err(|_| {
                    StoreError::InvalidStore("invalid enrichment attempts".into())
                })?,
                target_title: row.target_title,
                target_excerpt: row.target_excerpt,
                target_language: row.target_language,
                queued_at: row.queued_at,
                updated_at: row.updated_at,
                next_attempt_at: row.next_attempt_at,
                last_attempt_at: row.last_attempt_at,
                completed_at: row.completed_at,
                last_error_kind: row.last_error_kind,
            },
            expected_title_revision: row.expected_title_revision,
            expected_excerpt_revision: row.expected_excerpt_revision,
            expected_language_revision: row.expected_language_revision,
            lease_token: row.lease_token,
            lease_expires_at: row.lease_expires_at,
        })
    }
}
