//! Shared scope encoding for optional real native cryptographic engines.

use crate::{OrganisationId, UuidV7};

/// Security bound, not a measured transport or commercial capacity.
pub const MAX_NATIVE_MESSAGE_BYTES: usize = 65_536;

/// Bounded native crypto failure codes. Errors never contain keys or plaintext.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum NativeCryptoError {
    InvalidInput,
    ScopeMismatch,
    EpochMismatch,
    UnauthorisedDevice,
    AuthenticationFailed,
    Replay,
    Capacity,
    Storage,
}

/// Canonical organisation and room context. This is not a membership grant.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct NativeRoomScope {
    organisation: OrganisationId,
    room: UuidV7,
}

impl NativeRoomScope {
    pub fn new(organisation: OrganisationId, room: UuidV7) -> Self {
        Self { organisation, room }
    }

    pub fn organisation(&self) -> &OrganisationId {
        &self.organisation
    }

    pub fn room(&self) -> UuidV7 {
        self.room
    }

    #[cfg(any(feature = "openmls-engine", feature = "megolm-engine"))]
    pub(crate) fn binding(&self) -> Vec<u8> {
        let mut value = b"kodera-native-room-v1:\0".to_vec();
        value.extend_from_slice(self.organisation.as_str().as_bytes());
        value.extend_from_slice(self.room.as_bytes());
        value
    }
}
