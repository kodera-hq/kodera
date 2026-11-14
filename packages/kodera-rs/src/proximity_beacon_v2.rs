//! Rotating discovery advertisements. A group MAC is not device identity or an access grant.

use std::collections::BTreeMap;
use std::fmt;

use crate::{hmac_sha256, NativeCryptoError, OrganisationId, BEACON_ROTATION_WINDOW_SECS};

/// Service-data bytes; a two-byte AD header and two-byte service UUID fit alongside these in 31 bytes.
pub const PROXIMITY_BEACON_V2_BYTES: usize = 27;
const GRACE_SECONDS: u64 = 30;
const MAX_PEERS: usize = 4096;
const DOMAIN: &[u8] = b"kodera-proximity-beacon-v2:\0";

/// A public v2 discovery packet, containing no persistent device identifier or public key.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct ProximityBeaconV2([u8; PROXIMITY_BEACON_V2_BYTES]);

impl ProximityBeaconV2 {
    pub fn from_bytes(bytes: &[u8]) -> Result<Self, NativeCryptoError> {
        let raw: [u8; PROXIMITY_BEACON_V2_BYTES] = bytes
            .try_into()
            .map_err(|_| NativeCryptoError::InvalidInput)?;
        if raw[..3] != *b"KP\x02" {
            return Err(NativeCryptoError::InvalidInput);
        }
        Ok(Self(raw))
    }

    pub fn as_bytes(&self) -> &[u8; PROXIMITY_BEACON_V2_BYTES] {
        &self.0
    }

    fn window(&self) -> u32 {
        u32::from_be_bytes(self.0[3..7].try_into().expect("fixed window slice"))
    }

    fn pseudonym(&self) -> [u8; 8] {
        self.0[7..15].try_into().expect("fixed pseudonym slice")
    }

    fn sequence(&self) -> u32 {
        u32::from_be_bytes(self.0[15..19].try_into().expect("fixed sequence slice"))
    }
}

/// Authenticated discovery metadata, never evidence of a person's identity, presence or safety.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct BeaconObservationV2 {
    pub window: u32,
    pub pseudonym: [u8; 8],
    pub sequence: u32,
}

fn window(now: u64) -> Result<u32, NativeCryptoError> {
    (now / BEACON_ROTATION_WINDOW_SECS)
        .try_into()
        .map_err(|_| NativeCryptoError::InvalidInput)
}

fn transcript(organisation: &OrganisationId, packet: &[u8]) -> Vec<u8> {
    let mut value = DOMAIN.to_vec();
    value.extend_from_slice(organisation.as_str().as_bytes());
    value.extend_from_slice(packet);
    value
}

/// Provision with a separate organisation discovery key and private per-device beacon seed.
/// Members sharing the discovery key can forge discovery packets: this is not authorisation.
pub struct ProximityBeaconV2Sender {
    organisation: OrganisationId,
    discovery_key: [u8; 32],
    device_seed: [u8; 32],
    last_window: Option<u32>,
    sequence: u64,
}

impl fmt::Debug for ProximityBeaconV2Sender {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str("ProximityBeaconV2Sender([redacted])")
    }
}

impl Drop for ProximityBeaconV2Sender {
    fn drop(&mut self) {
        // Logical teardown only; no physical zeroisation of copies/allocations is promised.
        self.discovery_key.fill(0);
        self.device_seed.fill(0);
    }
}

impl ProximityBeaconV2Sender {
    pub fn new(
        organisation: OrganisationId,
        discovery_key: [u8; 32],
        device_seed: [u8; 32],
    ) -> Result<Self, NativeCryptoError> {
        if discovery_key == [0; 32] || device_seed == [0; 32] || discovery_key == device_seed {
            return Err(NativeCryptoError::InvalidInput);
        }
        Ok(Self {
            organisation,
            discovery_key,
            device_seed,
            last_window: None,
            sequence: 0,
        })
    }

    pub fn emit_at(
        &mut self,
        now_unix_seconds: u64,
    ) -> Result<ProximityBeaconV2, NativeCryptoError> {
        let current = window(now_unix_seconds)?;
        if self.last_window.is_some_and(|last| current < last) {
            return Err(NativeCryptoError::EpochMismatch);
        }
        let sequence = if self.last_window == Some(current) {
            self.sequence
        } else {
            0
        };
        let number: u32 = sequence
            .try_into()
            .map_err(|_| NativeCryptoError::Capacity)?;
        let mut context = transcript(&self.organisation, &current.to_be_bytes());
        context.extend_from_slice(&self.discovery_key);
        let pseudonym = hmac_sha256(&self.device_seed, &context);
        let mut raw = [0; PROXIMITY_BEACON_V2_BYTES];
        raw[..3].copy_from_slice(b"KP\x02");
        raw[3..7].copy_from_slice(&current.to_be_bytes());
        raw[7..15].copy_from_slice(&pseudonym[..8]);
        raw[15..19].copy_from_slice(&number.to_be_bytes());
        let tag = hmac_sha256(
            &self.discovery_key,
            &transcript(&self.organisation, &raw[..19]),
        );
        raw[19..].copy_from_slice(&tag[..8]);
        self.last_window = Some(current);
        self.sequence = sequence + 1;
        Ok(ProximityBeaconV2(raw))
    }
}

/// Bounded per-window replay tracking. No hardware radio, membership or persistence is supplied.
pub struct ProximityBeaconV2Receiver {
    organisation: OrganisationId,
    discovery_key: [u8; 32],
    capacity: usize,
    latest_clock_seconds: Option<u64>,
    seen: BTreeMap<(u32, [u8; 8]), u32>,
}

impl fmt::Debug for ProximityBeaconV2Receiver {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str("ProximityBeaconV2Receiver([redacted])")
    }
}

impl Drop for ProximityBeaconV2Receiver {
    fn drop(&mut self) {
        self.discovery_key.fill(0);
    }
}

impl ProximityBeaconV2Receiver {
    pub fn new(
        organisation: OrganisationId,
        discovery_key: [u8; 32],
        capacity: usize,
    ) -> Result<Self, NativeCryptoError> {
        if discovery_key == [0; 32] || !(1..=MAX_PEERS).contains(&capacity) {
            return Err(NativeCryptoError::InvalidInput);
        }
        Ok(Self {
            organisation,
            discovery_key,
            capacity,
            latest_clock_seconds: None,
            seen: BTreeMap::new(),
        })
    }

    pub fn accept_at(
        &mut self,
        bytes: &[u8],
        now_unix_seconds: u64,
    ) -> Result<BeaconObservationV2, NativeCryptoError> {
        let packet = ProximityBeaconV2::from_bytes(bytes)?;
        let current = window(now_unix_seconds)?;
        if self
            .latest_clock_seconds
            .is_some_and(|last| now_unix_seconds < last)
        {
            return Err(NativeCryptoError::EpochMismatch);
        }
        let previous_admitted = current.checked_sub(1) == Some(packet.window())
            && now_unix_seconds % BEACON_ROTATION_WINDOW_SECS <= GRACE_SECONDS;
        if packet.window() != current && !previous_admitted {
            return Err(NativeCryptoError::EpochMismatch);
        }
        let expected = hmac_sha256(
            &self.discovery_key,
            &transcript(&self.organisation, &bytes[..19]),
        );
        let mismatch = expected[..8]
            .iter()
            .zip(&bytes[19..])
            .fold(0u8, |different, (a, b)| different | (a ^ b));
        if mismatch != 0 {
            return Err(NativeCryptoError::AuthenticationFailed);
        }
        let identity = (packet.window(), packet.pseudonym());
        if self
            .seen
            .get(&identity)
            .is_some_and(|last| packet.sequence() <= *last)
        {
            return Err(NativeCryptoError::Replay);
        }
        let oldest = current.saturating_sub(u32::from(
            now_unix_seconds % BEACON_ROTATION_WINDOW_SECS <= GRACE_SECONDS,
        ));
        let retained = self
            .seen
            .keys()
            .filter(|(epoch, _)| *epoch >= oldest)
            .count();
        if !self.seen.contains_key(&identity) && retained >= self.capacity {
            return Err(NativeCryptoError::Capacity);
        }
        self.seen.retain(|(epoch, _), _| *epoch >= oldest);
        self.seen.insert(identity, packet.sequence());
        self.latest_clock_seconds = Some(now_unix_seconds);
        Ok(BeaconObservationV2 {
            window: packet.window(),
            pseudonym: packet.pseudonym(),
            sequence: packet.sequence(),
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn organisation() -> OrganisationId {
        OrganisationId::parse("00000000-0000-4000-8000-000000000001").unwrap()
    }

    #[test]
    fn independent_public_vectors_and_every_wire_bit_refuse_without_burning_a_retry() {
        let values: BTreeMap<&str, &str> = include_str!("../vectors/proximity-beacon-v2.txt")
            .lines()
            .filter_map(|line| line.split_once('='))
            .collect();
        let decode = |hex: &str| -> Vec<u8> {
            hex.as_bytes()
                .chunks_exact(2)
                .map(|pair| u8::from_str_radix(std::str::from_utf8(pair).unwrap(), 16).unwrap())
                .collect()
        };
        let mut sender = ProximityBeaconV2Sender::new(organisation(), [1; 32], [2; 32]).unwrap();
        let first = sender.emit_at(1_700_000_000).unwrap();
        assert_eq!(first.as_bytes().as_slice(), decode(values["sequence_zero"]));
        assert_eq!(
            sender.emit_at(1_700_000_000).unwrap().as_bytes().as_slice(),
            decode(values["sequence_one"])
        );
        assert_eq!(
            sender
                .emit_at((1_700_000_000 / 300 + 1) * 300)
                .unwrap()
                .as_bytes()
                .as_slice(),
            decode(values["next_window"])
        );
        for index in 0..PROXIMITY_BEACON_V2_BYTES {
            for bit in 0..8 {
                let mut changed = *first.as_bytes();
                changed[index] ^= 1 << bit;
                let mut receiver =
                    ProximityBeaconV2Receiver::new(organisation(), [1; 32], 1).unwrap();
                let expected = if index < 3 {
                    NativeCryptoError::InvalidInput
                } else if index < 7 {
                    NativeCryptoError::EpochMismatch
                } else {
                    NativeCryptoError::AuthenticationFailed
                };
                assert_eq!(receiver.accept_at(&changed, 1_700_000_000), Err(expected));
                receiver.accept_at(first.as_bytes(), 1_700_000_000).unwrap();
                assert_eq!(
                    receiver.accept_at(first.as_bytes(), 1_700_000_000),
                    Err(NativeCryptoError::Replay)
                );
            }
        }
    }

    #[test]
    fn rotations_replays_tampering_and_clock_rollback_refuse() {
        let mut sender = ProximityBeaconV2Sender::new(organisation(), [1; 32], [2; 32]).unwrap();
        let mut receiver = ProximityBeaconV2Receiver::new(organisation(), [1; 32], 2).unwrap();
        let first = sender.emit_at(900).unwrap();
        assert_eq!(
            receiver.accept_at(first.as_bytes(), 900).unwrap().sequence,
            0
        );
        assert_eq!(
            receiver.accept_at(first.as_bytes(), 900),
            Err(NativeCryptoError::Replay)
        );
        let next = sender.emit_at(901).unwrap();
        let mut corrupt = *next.as_bytes();
        corrupt[12] ^= 1;
        assert_eq!(
            receiver.accept_at(&corrupt, 901),
            Err(NativeCryptoError::AuthenticationFailed)
        );
        assert_eq!(
            receiver.accept_at(next.as_bytes(), 901).unwrap().sequence,
            1
        );
        let rotated = sender.emit_at(1200).unwrap();
        assert_ne!(first.pseudonym(), rotated.pseudonym());
        receiver.accept_at(rotated.as_bytes(), 1200).unwrap();
        assert_eq!(sender.emit_at(900), Err(NativeCryptoError::EpochMismatch));
        assert_eq!(
            receiver.accept_at(first.as_bytes(), 900),
            Err(NativeCryptoError::EpochMismatch)
        );
        assert_eq!(
            receiver.accept_at(first.as_bytes(), 1231),
            Err(NativeCryptoError::EpochMismatch)
        );
    }

    #[test]
    fn intra_window_clock_rollback_cannot_readmit_an_evicted_previous_window_packet() {
        let mut sender = ProximityBeaconV2Sender::new(organisation(), [1; 32], [2; 32]).unwrap();
        let mut receiver = ProximityBeaconV2Receiver::new(organisation(), [1; 32], 2).unwrap();
        let previous = sender.emit_at(900).unwrap();
        let previous_identity = (previous.window(), previous.pseudonym());
        receiver.accept_at(previous.as_bytes(), 1225).unwrap();
        assert!(receiver.seen.contains_key(&previous_identity));

        let current = sender.emit_at(1235).unwrap();
        receiver.accept_at(current.as_bytes(), 1235).unwrap();
        assert!(!receiver.seen.contains_key(&previous_identity));
        assert_eq!(
            receiver.accept_at(previous.as_bytes(), 1225),
            Err(NativeCryptoError::EpochMismatch)
        );
        assert!(!receiver.seen.contains_key(&previous_identity));
        assert_eq!(
            receiver.accept_at(previous.as_bytes(), 1235),
            Err(NativeCryptoError::EpochMismatch)
        );
        assert_eq!(
            receiver.accept_at(current.as_bytes(), 1235),
            Err(NativeCryptoError::Replay)
        );
    }

    #[test]
    fn scope_flood_and_refusal_do_not_reset_existing_replay_state() {
        let mut receiver = ProximityBeaconV2Receiver::new(organisation(), [1; 32], 1).unwrap();
        let mut a = ProximityBeaconV2Sender::new(organisation(), [1; 32], [2; 32]).unwrap();
        let mut b = ProximityBeaconV2Sender::new(organisation(), [1; 32], [3; 32]).unwrap();
        let packet = a.emit_at(900).unwrap();
        receiver.accept_at(packet.as_bytes(), 900).unwrap();
        assert_eq!(
            receiver.accept_at(b.emit_at(900).unwrap().as_bytes(), 900),
            Err(NativeCryptoError::Capacity)
        );
        assert_eq!(
            receiver.accept_at(packet.as_bytes(), 900),
            Err(NativeCryptoError::Replay)
        );
        receiver
            .accept_at(a.emit_at(901).unwrap().as_bytes(), 901)
            .unwrap();
        let other = OrganisationId::parse("00000000-0000-4000-8000-000000000002").unwrap();
        let mut foreign = ProximityBeaconV2Sender::new(other, [1; 32], [2; 32]).unwrap();
        assert_eq!(
            receiver.accept_at(foreign.emit_at(901).unwrap().as_bytes(), 901),
            Err(NativeCryptoError::AuthenticationFailed)
        );
    }
}
