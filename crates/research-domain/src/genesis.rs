use serde::{Deserialize, Serialize};

use crate::{
    DOMAIN_SCHEMA_VERSION, DomainError, DomainResult, LORO_CODEC, PROTOCOL_VERSION,
    identity::validate_uuid_v7,
};

pub const SYNC_FORMAT: &str = "researchpocket-sync";

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct LibraryGenesis {
    pub format: String,
    pub protocol_version: u8,
    pub domain_schema_version: u16,
    pub loro_codec: String,
    pub required_features: Vec<String>,
    pub library_id: String,
    pub created_at: String,
}

impl LibraryGenesis {
    pub fn new(library_id: &str, created_at: &str) -> DomainResult<Self> {
        let genesis = Self {
            format: SYNC_FORMAT.to_owned(),
            protocol_version: PROTOCOL_VERSION,
            domain_schema_version: DOMAIN_SCHEMA_VERSION,
            loro_codec: LORO_CODEC.to_owned(),
            required_features: Vec::new(),
            library_id: library_id.to_owned(),
            created_at: created_at.to_owned(),
        };
        genesis.validate()?;
        Ok(genesis)
    }

    pub fn validate(&self) -> DomainResult<()> {
        if self.format != SYNC_FORMAT {
            return Err(DomainError::InvalidState(format!(
                "unsupported synchronization format {:?}",
                self.format
            )));
        }
        if self.protocol_version != PROTOCOL_VERSION {
            return Err(DomainError::UnsupportedProtocol(self.protocol_version));
        }
        if self.domain_schema_version != DOMAIN_SCHEMA_VERSION {
            return Err(DomainError::UnsupportedDomainSchema(
                self.domain_schema_version,
            ));
        }
        if self.loro_codec != LORO_CODEC {
            return Err(DomainError::UnsupportedCodec(self.loro_codec.clone()));
        }
        if let Some(feature) = self.required_features.first() {
            return Err(DomainError::UnsupportedFeature(feature.clone()));
        }
        validate_uuid_v7(&self.library_id, "library ID")?;
        if self.created_at.trim().is_empty() {
            return Err(DomainError::InvalidState(
                "genesis creation time cannot be blank".into(),
            ));
        }
        Ok(())
    }
}
