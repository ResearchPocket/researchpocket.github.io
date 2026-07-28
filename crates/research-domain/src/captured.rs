use chrono::{DateTime, FixedOffset};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

use crate::{DomainError, DomainResult, validate_item_url};

pub const CAPTURED_CONTENT_PREFIX: &str = "sync/v2/content/sha256/";
pub const CAPTURED_MARKDOWN_MEDIA_TYPE: &str = "text/markdown; charset=utf-8";
pub const MAX_CAPTURED_DOCUMENT_BYTES: usize = 4 * 1024 * 1024;

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct CapturedDocumentProvenance {
    pub provider: String,
    pub source_url: String,
    pub captured_at: String,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct CapturedDocumentRef {
    pub sha256: String,
    pub byte_length: u64,
    pub media_type: String,
    pub provenance: CapturedDocumentProvenance,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize)]
pub struct CapturedDocumentArtifact {
    pub path: String,
    pub markdown: String,
    pub reference: CapturedDocumentRef,
}

pub fn create_captured_document(
    markdown: &str,
    provider: &str,
    source_url: &str,
    captured_at: &str,
) -> DomainResult<CapturedDocumentArtifact> {
    let markdown = normalize_markdown(markdown)?;
    validate_provenance(provider, source_url, captured_at)?;
    let bytes = markdown.as_bytes();
    validate_size(bytes.len())?;
    let sha256 = sha256_hex(bytes);
    let byte_length = u64::try_from(bytes.len())
        .map_err(|_| DomainError::InvalidState("captured document is too large".into()))?;
    let reference = CapturedDocumentRef {
        sha256: sha256.clone(),
        byte_length,
        media_type: CAPTURED_MARKDOWN_MEDIA_TYPE.to_owned(),
        provenance: CapturedDocumentProvenance {
            provider: provider.to_owned(),
            source_url: source_url.to_owned(),
            captured_at: captured_at.to_owned(),
        },
    };
    Ok(CapturedDocumentArtifact {
        path: captured_content_path(&sha256)?,
        markdown,
        reference,
    })
}

pub fn validate_captured_document_ref(reference: &CapturedDocumentRef) -> DomainResult<()> {
    validate_hash(&reference.sha256)?;
    let byte_length = usize::try_from(reference.byte_length).map_err(|_| {
        DomainError::InvalidState("captured document length is too large".into())
    })?;
    validate_size(byte_length)?;
    if reference.media_type != CAPTURED_MARKDOWN_MEDIA_TYPE {
        return Err(DomainError::InvalidState(
            "captured document media type is unsupported".into(),
        ));
    }
    validate_provenance(
        &reference.provenance.provider,
        &reference.provenance.source_url,
        &reference.provenance.captured_at,
    )
}

pub fn validate_captured_content(path: &str, bytes: &[u8]) -> DomainResult<String> {
    validate_size(bytes.len())?;
    std::str::from_utf8(bytes)
        .map_err(|_| DomainError::InvalidState("captured document is not UTF-8".into()))?;
    let sha256 = sha256_hex(bytes);
    let expected_path = captured_content_path(&sha256)?;
    if path != expected_path {
        return Err(DomainError::Integrity {
            path: path.to_owned(),
            expected: expected_path,
            actual: path.to_owned(),
        });
    }
    Ok(sha256)
}

pub fn validate_captured_content_for_ref(
    path: &str,
    bytes: &[u8],
    reference: &CapturedDocumentRef,
) -> DomainResult<()> {
    validate_captured_document_ref(reference)?;
    let sha256 = validate_captured_content(path, bytes)?;
    if sha256 != reference.sha256 {
        return Err(DomainError::Integrity {
            path: path.to_owned(),
            expected: reference.sha256.clone(),
            actual: sha256,
        });
    }
    let byte_length = u64::try_from(bytes.len())
        .map_err(|_| DomainError::InvalidState("captured document is too large".into()))?;
    if byte_length != reference.byte_length {
        return Err(DomainError::InvalidState(
            "captured document byte length does not match its reference".into(),
        ));
    }
    Ok(())
}

pub fn captured_content_path(sha256: &str) -> DomainResult<String> {
    validate_hash(sha256)?;
    Ok(format!(
        "{CAPTURED_CONTENT_PREFIX}{}/{}.md",
        &sha256[..2],
        sha256
    ))
}

fn normalize_markdown(value: &str) -> DomainResult<String> {
    let normalized_newlines = value.replace("\r\n", "\n").replace('\r', "\n");
    let sanitized = normalized_newlines
        .chars()
        .map(|character| {
            if character.is_control() && !matches!(character, '\n' | '\t') {
                ' '
            } else {
                character
            }
        })
        .collect::<String>();
    let markdown = sanitized.trim();
    if markdown.is_empty() {
        return Err(DomainError::InvalidState(
            "captured document cannot be blank".into(),
        ));
    }
    validate_size(markdown.len())?;
    Ok(markdown.to_owned())
}

fn validate_provenance(
    provider: &str,
    source_url: &str,
    captured_at: &str,
) -> DomainResult<()> {
    if provider != "firecrawl" {
        return Err(DomainError::InvalidState(
            "captured document provider is unsupported".into(),
        ));
    }
    validate_item_url(source_url)?;
    DateTime::<FixedOffset>::parse_from_rfc3339(captured_at)
        .map_err(|_| DomainError::InvalidState("captured time is not RFC 3339".into()))?;
    Ok(())
}

fn validate_hash(value: &str) -> DomainResult<()> {
    if value.len() != 64
        || !value
            .bytes()
            .all(|byte| byte.is_ascii_digit() || matches!(byte, b'a'..=b'f'))
    {
        return Err(DomainError::InvalidState(
            "captured document hash is not lowercase SHA-256".into(),
        ));
    }
    Ok(())
}

fn validate_size(bytes: usize) -> DomainResult<()> {
    if bytes == 0 || bytes > MAX_CAPTURED_DOCUMENT_BYTES {
        return Err(DomainError::InvalidState(format!(
            "captured document must contain 1 to {MAX_CAPTURED_DOCUMENT_BYTES} UTF-8 bytes"
        )));
    }
    Ok(())
}

fn sha256_hex(bytes: &[u8]) -> String {
    let digest = Sha256::digest(bytes);
    digest.iter().map(|byte| format!("{byte:02x}")).collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    const URL: &str = "https://example.com/article";
    const TIME: &str = "2026-07-28T12:00:00+05:30";

    #[test]
    fn content_is_normalized_and_addressed_by_exact_bytes() {
        let artifact =
            create_captured_document("  # Title\r\n\rBody\u{0000}  ", "firecrawl", URL, TIME)
                .expect("artifact");
        assert_eq!(artifact.markdown, "# Title\n\nBody");
        assert_eq!(
            artifact.reference.byte_length,
            artifact.markdown.len() as u64
        );
        validate_captured_content_for_ref(
            &artifact.path,
            artifact.markdown.as_bytes(),
            &artifact.reference,
        )
        .expect("valid content");
    }

    #[test]
    fn path_hash_length_and_size_mismatches_fail_closed() {
        let artifact =
            create_captured_document("# Title", "firecrawl", URL, TIME).expect("artifact");
        assert!(validate_captured_content(&artifact.path, b"# Changed").is_err());
        let mut wrong_length = artifact.reference.clone();
        wrong_length.byte_length += 1;
        assert!(
            validate_captured_content_for_ref(
                &artifact.path,
                artifact.markdown.as_bytes(),
                &wrong_length,
            )
            .is_err()
        );
        assert!(
            create_captured_document(
                &"x".repeat(MAX_CAPTURED_DOCUMENT_BYTES + 1),
                "firecrawl",
                URL,
                TIME,
            )
            .is_err()
        );
    }
}
