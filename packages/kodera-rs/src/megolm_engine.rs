//! Real Megolm encryption with authenticated application scope, explicit rekeying and replay bounds.

use std::collections::{BTreeSet, HashSet};
use std::fmt;

use vodozemac::megolm::{
    GroupSession, InboundGroupSession, MegolmMessage, SessionConfig, SessionKey,
};

use crate::{NativeCryptoError, NativeRoomScope, MAX_NATIVE_MESSAGE_BYTES};

const MAX_EPOCH_MESSAGES: usize = 4096;
const MAX_EPOCHS: usize = 4096;

/// A sensitive room key. It has no plaintext Debug/Display or implicit serialization.
pub struct MegolmEpochKey {
    scope: NativeRoomScope,
    epoch: u64,
    key: SessionKey,
}

impl fmt::Debug for MegolmEpochKey {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str("MegolmEpochKey([redacted])")
    }
}

/// Untrusted transport metadata plus an actual signed Megolm ciphertext.
#[derive(Debug, Clone)]
pub struct MegolmPacket {
    pub scope: NativeRoomScope,
    pub epoch: u64,
    pub session_id: String,
    pub ciphertext: Vec<u8>,
}

/// One software-backed Megolm sending session. Native protected persistence is external.
pub struct MegolmEpochSender {
    scope: NativeRoomScope,
    epoch: u64,
    session: GroupSession,
    messages: usize,
}

impl fmt::Debug for MegolmEpochSender {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str("MegolmEpochSender([redacted])")
    }
}

impl MegolmEpochSender {
    pub fn new(scope: NativeRoomScope) -> Self {
        Self {
            scope,
            epoch: 1,
            session: GroupSession::new(SessionConfig::version_1()),
            messages: 0,
        }
    }

    pub fn epoch(&self) -> u64 {
        self.epoch
    }

    pub fn export_key(&self) -> MegolmEpochKey {
        MegolmEpochKey {
            scope: self.scope.clone(),
            epoch: self.epoch,
            key: self.session.session_key(),
        }
    }

    pub fn rotate(&mut self) -> Result<MegolmEpochKey, NativeCryptoError> {
        let next = self
            .epoch
            .checked_add(1)
            .ok_or(NativeCryptoError::Capacity)?;
        let fresh = GroupSession::new(SessionConfig::version_1());
        if fresh.session_id() == self.session.session_id() {
            return Err(NativeCryptoError::AuthenticationFailed);
        }
        self.session = fresh;
        self.epoch = next;
        self.messages = 0;
        Ok(self.export_key())
    }

    pub fn seal(&mut self, plaintext: &[u8]) -> Result<MegolmPacket, NativeCryptoError> {
        if plaintext.len() > MAX_NATIVE_MESSAGE_BYTES {
            return Err(NativeCryptoError::InvalidInput);
        }
        if self.messages == MAX_EPOCH_MESSAGES {
            return Err(NativeCryptoError::Capacity);
        }
        let mut bound = self.scope.binding();
        bound.extend_from_slice(&self.epoch.to_be_bytes());
        bound.extend_from_slice(plaintext);
        let ciphertext = self.session.encrypt(&bound).to_bytes();
        self.messages += 1;
        Ok(MegolmPacket {
            scope: self.scope.clone(),
            epoch: self.epoch,
            session_id: self.session.session_id(),
            ciphertext,
        })
    }
}

/// Receiving state for one authorised sender, supplied with keys over an authenticated channel.
/// Every retained index survives until a fresh epoch key; capacity refuses rather than evicts.
pub struct MegolmEpochReceiver {
    scope: NativeRoomScope,
    epoch: u64,
    session: InboundGroupSession,
    seen: BTreeSet<u32>,
    session_ids: HashSet<String>,
}

impl fmt::Debug for MegolmEpochReceiver {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str("MegolmEpochReceiver([redacted])")
    }
}

impl MegolmEpochReceiver {
    pub fn new(scope: NativeRoomScope, key: &MegolmEpochKey) -> Result<Self, NativeCryptoError> {
        if scope != key.scope || key.epoch == 0 {
            return Err(NativeCryptoError::ScopeMismatch);
        }
        let session = InboundGroupSession::new(&key.key, SessionConfig::version_1());
        let session_ids = HashSet::from([session.session_id()]);
        Ok(Self {
            scope,
            epoch: key.epoch,
            session,
            seen: BTreeSet::new(),
            session_ids,
        })
    }

    pub fn epoch(&self) -> u64 {
        self.epoch
    }

    pub fn install_key(&mut self, key: &MegolmEpochKey) -> Result<(), NativeCryptoError> {
        if key.scope != self.scope {
            return Err(NativeCryptoError::ScopeMismatch);
        }
        if key.epoch <= self.epoch {
            return Err(NativeCryptoError::EpochMismatch);
        }
        if self.session_ids.len() == MAX_EPOCHS {
            return Err(NativeCryptoError::Capacity);
        }
        let session = InboundGroupSession::new(&key.key, SessionConfig::version_1());
        if self.session_ids.contains(&session.session_id()) {
            return Err(NativeCryptoError::Replay);
        }
        self.session_ids.insert(session.session_id());
        self.session = session;
        self.epoch = key.epoch;
        self.seen.clear();
        Ok(())
    }

    pub fn open(&mut self, packet: &MegolmPacket) -> Result<Vec<u8>, NativeCryptoError> {
        if packet.scope != self.scope {
            return Err(NativeCryptoError::ScopeMismatch);
        }
        if packet.epoch != self.epoch {
            return Err(NativeCryptoError::EpochMismatch);
        }
        if packet.session_id != self.session.session_id()
            || packet.ciphertext.len() > MAX_NATIVE_MESSAGE_BYTES + 1024
        {
            return Err(NativeCryptoError::AuthenticationFailed);
        }
        let message = MegolmMessage::from_bytes(&packet.ciphertext)
            .map_err(|_| NativeCryptoError::AuthenticationFailed)?;
        let decrypted = self
            .session
            .decrypt(&message)
            .map_err(|_| NativeCryptoError::AuthenticationFailed)?;
        let mut binding = self.scope.binding();
        binding.extend_from_slice(&self.epoch.to_be_bytes());
        if !decrypted.plaintext.starts_with(&binding) {
            return Err(NativeCryptoError::ScopeMismatch);
        }
        if self.seen.contains(&decrypted.message_index) {
            return Err(NativeCryptoError::Replay);
        }
        if self.seen.len() == MAX_EPOCH_MESSAGES {
            return Err(NativeCryptoError::Capacity);
        }
        let plaintext = &decrypted.plaintext[binding.len()..];
        if plaintext.len() > MAX_NATIVE_MESSAGE_BYTES {
            return Err(NativeCryptoError::InvalidInput);
        }
        self.seen.insert(decrypted.message_index);
        Ok(plaintext.to_vec())
    }
}

#[cfg(feature = "openmls-engine")]
impl MegolmEpochKey {
    /// Encrypt the sensitive Megolm key inside its authenticated MLS room.
    pub fn seal_to_mls(
        &self,
        mls: &mut crate::OpenMlsSession,
    ) -> Result<crate::MlsCiphertextEnvelope, NativeCryptoError> {
        if mls.scope() != &self.scope {
            return Err(NativeCryptoError::ScopeMismatch);
        }
        let mut plaintext = b"kodera-megolm-key-v1:\0".to_vec();
        plaintext.extend_from_slice(&self.epoch.to_be_bytes());
        plaintext.extend_from_slice(&self.key.to_bytes());
        mls.seal(&plaintext)
    }

    /// Require the expected sender from the trusted room-key distribution policy.
    pub fn open_from_mls(
        mls: &mut crate::OpenMlsSession,
        envelope: &crate::MlsCiphertextEnvelope,
        expected_sender: &crate::Ed25519PublicKey,
    ) -> Result<Self, NativeCryptoError> {
        if &envelope.sender_device_key != expected_sender {
            return Err(NativeCryptoError::UnauthorisedDevice);
        }
        let plaintext = mls.open(envelope)?;
        let prefix = b"kodera-megolm-key-v1:\0";
        if !plaintext.starts_with(prefix) || plaintext.len() < prefix.len() + 8 {
            return Err(NativeCryptoError::InvalidInput);
        }
        let epoch = u64::from_be_bytes(
            plaintext[prefix.len()..prefix.len() + 8]
                .try_into()
                .map_err(|_| NativeCryptoError::InvalidInput)?,
        );
        if epoch == 0 {
            return Err(NativeCryptoError::InvalidInput);
        }
        let key = SessionKey::from_bytes(&plaintext[prefix.len() + 8..])
            .map_err(|_| NativeCryptoError::AuthenticationFailed)?;
        Ok(Self {
            scope: mls.scope().clone(),
            epoch,
            key,
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{OrganisationId, UuidV7};

    fn scope(index: u8) -> NativeRoomScope {
        NativeRoomScope::new(
            OrganisationId::parse("00000000-0000-4000-8000-000000000001").unwrap(),
            UuidV7::from_parts(1000, [index; 10]),
        )
    }

    #[test]
    fn real_ratchet_rekeys_and_refuses_tampering_replay_scope_and_old_epoch() {
        let mut sender = MegolmEpochSender::new(scope(1));
        let old_key = sender.export_key();
        let mut receiver = MegolmEpochReceiver::new(scope(1), &old_key).unwrap();
        let a = sender.seal(b"first confidential message").unwrap();
        let b = sender.seal(b"second confidential message").unwrap();
        assert!(!a.ciphertext.windows(5).any(|part| part == b"first"));
        let mut bad = a.clone();
        let end = bad.ciphertext.len() - 1;
        bad.ciphertext[end] ^= 1;
        assert_eq!(
            receiver.open(&bad),
            Err(NativeCryptoError::AuthenticationFailed)
        );
        assert_eq!(receiver.open(&b).unwrap(), b"second confidential message");
        assert_eq!(receiver.open(&a).unwrap(), b"first confidential message");
        assert_eq!(receiver.open(&a), Err(NativeCryptoError::Replay));
        let next_key = sender.rotate().unwrap();
        receiver.install_key(&next_key).unwrap();
        assert_eq!(receiver.open(&a), Err(NativeCryptoError::EpochMismatch));
        assert_eq!(
            receiver.install_key(&old_key),
            Err(NativeCryptoError::EpochMismatch)
        );
        let current = sender
            .seal(b"after a fresh cryptographic session key")
            .unwrap();
        let mut old_receiver = MegolmEpochReceiver::new(scope(1), &old_key).unwrap();
        let mut relabelled = current.clone();
        relabelled.epoch = 1;
        relabelled.session_id = a.session_id;
        assert_eq!(
            old_receiver.open(&relabelled),
            Err(NativeCryptoError::AuthenticationFailed)
        );
        let mut wrong_scope = current.clone();
        wrong_scope.scope = scope(2);
        assert_eq!(
            receiver.open(&wrong_scope),
            Err(NativeCryptoError::ScopeMismatch)
        );
        assert_eq!(
            receiver.open(&current).unwrap(),
            b"after a fresh cryptographic session key"
        );
        assert!(format!("{old_key:?}").contains("[redacted]"));
    }

    #[test]
    fn relabelling_a_real_key_never_rebinds_scope_or_reuses_an_old_ratchet_epoch() {
        let mut sender = MegolmEpochSender::new(scope(1));
        let mut old = sender.export_key();
        let mut receiver = MegolmEpochReceiver::new(scope(1), &old).unwrap();
        let next = sender.rotate().unwrap();
        receiver.install_key(&next).unwrap();
        old.epoch = next.epoch + 1;
        assert_eq!(receiver.install_key(&old), Err(NativeCryptoError::Replay));
        assert_eq!(receiver.epoch(), next.epoch);
        let mut relabelled_key = sender.export_key();
        relabelled_key.scope = scope(2);
        let mut foreign = MegolmEpochReceiver::new(scope(2), &relabelled_key).unwrap();
        let message = sender
            .seal(b"the scope is inside the signed ciphertext")
            .unwrap();
        let mut changed = message.clone();
        changed.scope = scope(2);
        assert_eq!(
            foreign.open(&changed),
            Err(NativeCryptoError::ScopeMismatch)
        );
        assert_eq!(
            receiver.open(&message).unwrap(),
            b"the scope is inside the signed ciphertext"
        );
    }

    #[cfg(feature = "openmls-engine")]
    #[test]
    fn actual_megolm_key_delivery_is_encrypted_inside_its_mls_room_and_sender_policy() {
        use crate::{OpenMlsMember, OpenMlsSession};
        let a = OpenMlsMember::new(b"public-key-owner").unwrap();
        let b = OpenMlsMember::new(b"public-key-recipient").unwrap();
        let roster = HashSet::from([a.device_key(), b.device_key()]);
        let owner = a.device_key();
        let mut mls_a: OpenMlsSession = a.create(scope(1)).unwrap();
        mls_a.replace_authorised_roster(roster.clone()).unwrap();
        let welcome = mls_a
            .add_member(b.key_package(), &b.device_key())
            .unwrap()
            .welcome
            .unwrap();
        let mut mls_b = b.join(scope(1), &welcome, roster).unwrap();
        let mut sender = MegolmEpochSender::new(scope(1));
        let encrypted_key = sender.export_key().seal_to_mls(&mut mls_a).unwrap();
        assert!(MegolmEpochKey::open_from_mls(&mut mls_b, &encrypted_key, &[9; 32]).is_err());
        let delivered = MegolmEpochKey::open_from_mls(&mut mls_b, &encrypted_key, &owner).unwrap();
        let mut receiver = MegolmEpochReceiver::new(scope(1), &delivered).unwrap();
        assert_eq!(
            receiver
                .open(&sender.seal(b"protected key distribution").unwrap())
                .unwrap(),
            b"protected key distribution"
        );
        let rotated_key = sender.rotate().unwrap().seal_to_mls(&mut mls_a).unwrap();
        let delivered = MegolmEpochKey::open_from_mls(&mut mls_b, &rotated_key, &owner).unwrap();
        receiver.install_key(&delivered).unwrap();
        assert_eq!(
            receiver.open(&sender.seal(b"fresh key").unwrap()).unwrap(),
            b"fresh key"
        );
    }
}
