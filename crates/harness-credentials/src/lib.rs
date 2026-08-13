use keyring::Entry;
use thiserror::Error;

const SERVICE: &str = "PersonalHarness";

#[derive(Debug, Error, PartialEq, Eq)]
pub enum CredentialError {
    #[error("credential \"{0}\" was not found in the OS credential store")]
    NotFound(String),
    #[error("the OS credential store could not read credential \"{0}\"")]
    ReadFailed(String),
    #[error("the OS credential store could not write credential \"{0}\"")]
    WriteFailed(String),
}

pub type Result<T> = std::result::Result<T, CredentialError>;

/// The server owns credential access behind this interface so API keys never
/// enter JSON configuration, logs, protocol responses, or adapter debug state.
pub trait CredentialStore: Send + Sync {
    fn read(&self, reference: &str) -> Result<String>;
    fn contains(&self, reference: &str) -> bool;
    fn write(&self, reference: &str, value: &str) -> Result<()>;
    fn remove(&self, reference: &str);
}

#[derive(Default)]
pub struct SystemCredentialStore;

impl SystemCredentialStore {
    pub fn new() -> Self {
        Self
    }

    fn entry(reference: &str) -> std::result::Result<Entry, keyring::Error> {
        Entry::new(SERVICE, reference)
    }
}

impl CredentialStore for SystemCredentialStore {
    fn read(&self, reference: &str) -> Result<String> {
        let entry = Self::entry(reference)
            .map_err(|_| CredentialError::ReadFailed(reference.to_owned()))?;
        match entry.get_password() {
            Ok(value) => Ok(value),
            Err(keyring::Error::NoEntry) => Err(CredentialError::NotFound(reference.to_owned())),
            Err(_) => Err(CredentialError::ReadFailed(reference.to_owned())),
        }
    }

    fn contains(&self, reference: &str) -> bool {
        Self::entry(reference)
            .and_then(|entry| entry.get_password())
            .is_ok()
    }

    fn write(&self, reference: &str, value: &str) -> Result<()> {
        Self::entry(reference)
            .and_then(|entry| entry.set_password(value))
            .map_err(|_| CredentialError::WriteFailed(reference.to_owned()))
    }

    fn remove(&self, reference: &str) {
        if let Ok(entry) = Self::entry(reference) {
            let _ = entry.delete_credential();
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn credential_errors_name_only_the_opaque_reference() {
        let error = CredentialError::WriteFailed("model-connections/work".into()).to_string();
        assert_eq!(
            error,
            "the OS credential store could not write credential \"model-connections/work\""
        );
        assert!(!error.contains("api-key"));
    }
}
