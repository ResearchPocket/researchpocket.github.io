use research_domain::{
    CapturedDocumentArtifact, CapturedDocumentRef, validate_captured_content_for_ref,
};
use sqlx::{Row, SqliteConnection};

use crate::{PendingCapturedDocument, StoreError, StoreResult, V2Store, store::now_rfc3339};

impl V2Store {
    pub async fn pending_captured_documents(
        &self,
    ) -> StoreResult<Vec<PendingCapturedDocument>> {
        let rows = sqlx::query(
            "SELECT path, sha256, markdown, byte_length, media_type, provider, source_url, \
             captured_at FROM captured_documents \
             WHERE remote_blob_sha IS NULL ORDER BY sha256 ASC",
        )
        .fetch_all(&self.pool)
        .await?;
        rows.into_iter()
            .map(|row| {
                let byte_length: i64 = row.try_get("byte_length")?;
                Ok(PendingCapturedDocument {
                    path: row.try_get("path")?,
                    sha256: row.try_get("sha256")?,
                    markdown: row.try_get("markdown")?,
                    reference: CapturedDocumentRef {
                        sha256: row.try_get("sha256")?,
                        byte_length: u64::try_from(byte_length).map_err(|_| {
                            StoreError::NumericRange("captured document byte length")
                        })?,
                        media_type: row.try_get("media_type")?,
                        provenance: research_domain::CapturedDocumentProvenance {
                            provider: row.try_get("provider")?,
                            source_url: row.try_get("source_url")?,
                            captured_at: row.try_get("captured_at")?,
                        },
                    },
                })
            })
            .collect()
    }

    pub async fn confirm_captured_document(
        &self,
        reference: &CapturedDocumentRef,
        path: &str,
        blob_sha: &str,
        bytes: &[u8],
    ) -> StoreResult<()> {
        validate_blob_sha(blob_sha)?;
        validate_captured_content_for_ref(path, bytes, reference)?;
        let markdown = std::str::from_utf8(bytes)
            .map_err(|_| StoreError::SyncIntegrity("captured document is not UTF-8".into()))?;
        let mut connection = self.pool.acquire().await?;
        sqlx::query("BEGIN IMMEDIATE")
            .execute(&mut *connection)
            .await?;
        let result = async {
            let existing = sqlx::query(
                "SELECT markdown, remote_blob_sha FROM captured_documents WHERE sha256 = ?",
            )
            .bind(&reference.sha256)
            .fetch_optional(&mut *connection)
            .await?;
            if let Some(existing) = existing {
                let stored: String = existing.try_get("markdown")?;
                if stored.as_bytes() != bytes {
                    return Err(StoreError::SyncIntegrity(
                        "captured document identity collision".into(),
                    ));
                }
                let observed: Option<String> = existing.try_get("remote_blob_sha")?;
                if observed
                    .as_deref()
                    .is_some_and(|observed| observed != blob_sha)
                {
                    return Err(StoreError::SyncIntegrity(
                        "immutable captured content changed Git identity".into(),
                    ));
                }
            } else {
                persist_reference_and_markdown(&mut connection, reference, path, markdown)
                    .await?;
            }
            sqlx::query("UPDATE captured_documents SET remote_blob_sha = ? WHERE sha256 = ?")
                .bind(blob_sha)
                .bind(&reference.sha256)
                .execute(&mut *connection)
                .await?;
            Ok(())
        }
        .await;
        match result {
            Ok(()) => {
                sqlx::query("COMMIT").execute(&mut *connection).await?;
                Ok(())
            }
            Err(error) => {
                let _ = sqlx::query("ROLLBACK").execute(&mut *connection).await;
                Err(error)
            }
        }
    }

    pub async fn captured_document_markdown(
        &self,
        sha256: &str,
    ) -> StoreResult<Option<String>> {
        Ok(
            sqlx::query_scalar("SELECT markdown FROM captured_documents WHERE sha256 = ?")
                .bind(sha256)
                .fetch_optional(&self.pool)
                .await?,
        )
    }
}

pub(crate) async fn persist_captured_document(
    connection: &mut SqliteConnection,
    artifact: &CapturedDocumentArtifact,
) -> StoreResult<()> {
    if let Some(existing) = sqlx::query_scalar::<_, String>(
        "SELECT markdown FROM captured_documents WHERE sha256 = ?",
    )
    .bind(&artifact.reference.sha256)
    .fetch_optional(&mut *connection)
    .await?
    {
        if existing.as_bytes() != artifact.markdown.as_bytes() {
            return Err(StoreError::SyncIntegrity(
                "captured document identity collision".into(),
            ));
        }
        return Ok(());
    }
    persist_reference_and_markdown(
        connection,
        &artifact.reference,
        &artifact.path,
        &artifact.markdown,
    )
    .await
}

async fn persist_reference_and_markdown(
    connection: &mut SqliteConnection,
    reference: &CapturedDocumentRef,
    path: &str,
    markdown: &str,
) -> StoreResult<()> {
    let byte_length = i64::try_from(reference.byte_length)
        .map_err(|_| StoreError::NumericRange("captured document byte length"))?;
    sqlx::query(
        "INSERT INTO captured_documents \
         (sha256, path, markdown, byte_length, media_type, provider, source_url, captured_at, \
          created_at, remote_blob_sha) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, NULL)",
    )
    .bind(&reference.sha256)
    .bind(path)
    .bind(markdown)
    .bind(byte_length)
    .bind(&reference.media_type)
    .bind(&reference.provenance.provider)
    .bind(&reference.provenance.source_url)
    .bind(&reference.provenance.captured_at)
    .bind(now_rfc3339())
    .execute(&mut *connection)
    .await?;
    Ok(())
}

fn validate_blob_sha(value: &str) -> StoreResult<()> {
    if !matches!(value.len(), 40 | 64)
        || !value
            .bytes()
            .all(|byte| byte.is_ascii_digit() || matches!(byte, b'a'..=b'f'))
    {
        return Err(StoreError::SyncIntegrity(
            "remote Git object identity is invalid".into(),
        ));
    }
    Ok(())
}
