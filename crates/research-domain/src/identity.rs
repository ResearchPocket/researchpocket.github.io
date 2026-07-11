use crate::{DomainError, DomainResult};

pub(crate) fn validate_uuid_v7(value: &str, label: &str) -> DomainResult<()> {
    let bytes = value.as_bytes();
    let valid = bytes.len() == 36
        && bytes[8] == b'-'
        && bytes[13] == b'-'
        && bytes[14] == b'7'
        && bytes[18] == b'-'
        && matches!(bytes[19], b'8' | b'9' | b'a' | b'b')
        && bytes[23] == b'-'
        && bytes.iter().enumerate().all(|(index, byte)| {
            matches!(index, 8 | 13 | 18 | 23)
                || byte.is_ascii_digit()
                || matches!(byte, b'a'..=b'f')
        });
    if !valid {
        return Err(DomainError::InvalidState(format!(
            "{label} {value:?} is not a canonical lowercase UUIDv7"
        )));
    }
    Ok(())
}
