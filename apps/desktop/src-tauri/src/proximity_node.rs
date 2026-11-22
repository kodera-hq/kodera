//! Desktop `#proximity` BLE/Wi-Fi packet verification and bounded local mesh node.

use kodera_rs::{
    compute_proximity_beacon, label_observed_proximity_senders, CoreError, DeviceIdentitySigner,
    Ed25519PublicKey, OrganisationId, ProximityFrame, ProximityHandle, ProximityMeshQueue,
    ProximityReplayGuard, ProximityRosterLabel, ProximityRosterTracker, SafetyStatus,
    SignatureVerifier, UuidV7, VerifiedProximityFrame, MAX_PROXIMITY_STATE_ENTRIES,
    MAX_PROXIMITY_TTL_HOPS,
};
use std::collections::{BTreeMap, HashSet};

#[cfg(test)]
mod tests;

fn constant_time_eq_8(a: &[u8; 8], b: &[u8; 8]) -> bool {
    a.iter()
        .zip(b.iter())
        .fold(0u8, |acc, (x, y)| acc | (x ^ y))
        == 0
}

/// Bridges `#proximity` BLE/Wi-Fi frame verification from `kodera-rs` to the Desktop IPC layer.
///
/// Accepts the current 5-minute beacon bucket as well as ±1 adjacent bucket (`±300s`) so offline
/// workstations/phones without NTP do not drop proximity check-ins at window edges.
pub fn verify_incoming_proximity_packet(
    observed_beacon: [u8; 8],
    org_beacon_salt: &[u8; 32],
    now_unix_secs: u64,
    raw_frame: &[u8],
    allowed_roster: &HashSet<Ed25519PublicKey>,
    verifier: &dyn SignatureVerifier,
    replay_guard: &mut ProximityReplayGuard,
) -> Result<Option<ProximityFrame>, CoreError> {
    let verified = verified_incoming_proximity_packet(
        observed_beacon,
        org_beacon_salt,
        now_unix_secs,
        raw_frame,
        allowed_roster,
        verifier,
    )?;
    if !replay_guard.accept_once(verified.frame().message_id) {
        return Ok(None);
    }
    Ok(Some(verified.frame().clone()))
}

/// Verifies an incoming proximity packet against the local system wall-clock (`SystemTime::now()`).
pub fn verify_incoming_proximity_packet_now(
    observed_beacon: [u8; 8],
    org_beacon_salt: &[u8; 32],
    raw_frame: &[u8],
    allowed_roster: &HashSet<Ed25519PublicKey>,
    verifier: &dyn SignatureVerifier,
    replay_guard: &mut ProximityReplayGuard,
) -> Result<Option<ProximityFrame>, CoreError> {
    verify_incoming_proximity_packet(
        observed_beacon,
        org_beacon_salt,
        kodera_rs::system_unix_secs(),
        raw_frame,
        allowed_roster,
        verifier,
        replay_guard,
    )
}

fn verified_incoming_proximity_packet(
    observed_beacon: [u8; 8],
    org_beacon_salt: &[u8; 32],
    now_unix_secs: u64,
    raw_frame: &[u8],
    allowed_roster: &HashSet<Ed25519PublicKey>,
    verifier: &dyn SignatureVerifier,
) -> Result<VerifiedProximityFrame, CoreError> {
    let candidates = [
        now_unix_secs.saturating_sub(300),
        now_unix_secs,
        now_unix_secs.saturating_add(300),
    ];
    let beacon_matches = candidates.iter().any(|&ts| {
        let expected = compute_proximity_beacon(org_beacon_salt, ts);
        constant_time_eq_8(&observed_beacon, &expected)
    });
    if !beacon_matches {
        return Err(CoreError::UnauthorizedSender);
    }
    // The receive path reads the verifier's clock: a frame dated past the shared skew bound
    // would otherwise outrank every real check-in from its sender until the clock caught up.
    ProximityFrame::decode(raw_frame)?.verified_at(
        allowed_roster,
        verifier,
        now_unix_secs.saturating_mul(1000),
    )
}

/// Stateful backend seam for a future desktop IPC/radio adapter. It performs no radio,
/// network, key storage or provisioning operation. Only a trusted native signature provider
/// may supply `signer`/`verifier`; these are not caller-selectable IPC payloads.
pub struct DesktopProximityNode {
    pub(crate) org_beacon_salt: [u8; 32],
    pub(crate) allowed_roster: HashSet<Ed25519PublicKey>,
    /// Pseudonyms members picked, by provisioned key. Display metadata only: never consulted to
    /// admit, refuse or deduplicate anything.
    pub(crate) dedicated_handles: BTreeMap<Ed25519PublicKey, ProximityHandle>,
    pub(crate) replay_guard: ProximityReplayGuard,
    pub(crate) mesh_queue: ProximityMeshQueue,
    pub(crate) roster: ProximityRosterTracker,
}

impl DesktopProximityNode {
    /// Logical teardown plus overwriting the salt. Rust allocations/allocator copies are not
    /// guaranteed to be physically zeroised; this is not a secure-memory implementation.
    pub(crate) fn clear(&mut self) {
        self.org_beacon_salt.fill(0);
        self.allowed_roster.clear();
        self.dedicated_handles.clear();
        self.replay_guard.clear();
        self.mesh_queue.clear();
        self.roster.clear();
    }

    pub fn new(
        org_beacon_salt: [u8; 32],
        allowed_roster: HashSet<Ed25519PublicKey>,
        max_queue_capacity: usize,
    ) -> Result<Self, CoreError> {
        if allowed_roster.len() > MAX_PROXIMITY_STATE_ENTRIES {
            return Err(CoreError::InvalidCapacity);
        }
        Ok(Self {
            org_beacon_salt,
            roster: ProximityRosterTracker::new(allowed_roster.len())?,
            allowed_roster,
            dedicated_handles: BTreeMap::new(),
            replay_guard: ProximityReplayGuard::new(MAX_PROXIMITY_STATE_ENTRIES),
            mesh_queue: ProximityMeshQueue::new(max_queue_capacity)?,
        })
    }

    pub fn current_beacon(&self, now_unix_secs: u64) -> [u8; 8] {
        compute_proximity_beacon(&self.org_beacon_salt, now_unix_secs)
    }

    pub fn current_beacon_now(&self) -> [u8; 8] {
        self.current_beacon(kodera_rs::system_unix_secs())
    }

    pub fn create_local_checkin(
        &mut self,
        message_id: UuidV7,
        status: SafetyStatus,
        text: &str,
        signer: &dyn DeviceIdentitySigner,
        verifier: &dyn SignatureVerifier,
    ) -> Result<Vec<u8>, CoreError> {
        let frame =
            ProximityFrame::new_signed(message_id, MAX_PROXIMITY_TTL_HOPS, status, text, signer)?;
        let verified = frame.verified(&self.allowed_roster, verifier)?;
        let wire = frame.encode()?;
        if self.replay_guard.contains(&message_id) || self.mesh_queue.contains(&message_id) {
            return Err(CoreError::ReplayDetected);
        }
        if !self.roster.can_observe(&verified)? {
            return Err(CoreError::StaleFrame);
        }
        if !self.mesh_queue.enqueue_local(&verified) {
            return Err(CoreError::CapacityExceeded);
        }
        // Capacity is provisioned from the same immutable roster checked above.
        self.roster.observe(&verified)?;
        self.replay_guard.accept_once(message_id);
        Ok(wire)
    }

    pub fn ingest_peer_frame(
        &mut self,
        observed_beacon: [u8; 8],
        now_unix_secs: u64,
        raw_frame: &[u8],
        verifier: &dyn SignatureVerifier,
    ) -> Result<Option<ProximityFrame>, CoreError> {
        let verified = verified_incoming_proximity_packet(
            observed_beacon,
            &self.org_beacon_salt,
            now_unix_secs,
            raw_frame,
            &self.allowed_roster,
            verifier,
        )?;
        let frame = verified.frame();
        if self.replay_guard.contains(&frame.message_id) || !self.roster.can_observe(&verified)? {
            return Ok(None);
        }
        self.roster.observe(&verified)?;
        self.replay_guard.accept_once(frame.message_id);
        // A valid check-in still updates the roster when TTL is exhausted or lower-priority
        // radio traffic is refused by the bounded queue. Neither case invalidates its author.
        self.mesh_queue.enqueue_relay(&verified);
        Ok(Some(frame.clone()))
    }

    pub fn ingest_peer_frame_now(
        &mut self,
        observed_beacon: [u8; 8],
        raw_frame: &[u8],
        verifier: &dyn SignatureVerifier,
    ) -> Result<Option<ProximityFrame>, CoreError> {
        self.ingest_peer_frame(
            observed_beacon,
            kodera_rs::system_unix_secs(),
            raw_frame,
            verifier,
        )
    }

    #[allow(clippy::too_many_arguments)]
    pub fn create_org_bound_checkin(
        &mut self,
        organisation_id: &OrganisationId,
        now_unix_secs: u64,
        message_id: UuidV7,
        status: SafetyStatus,
        text: &str,
        signer: &dyn DeviceIdentitySigner,
        verifier: &dyn SignatureVerifier,
    ) -> Result<Vec<u8>, CoreError> {
        let beacon = self.current_beacon(now_unix_secs);
        let frame = ProximityFrame::sign_for_organisation(
            organisation_id,
            beacon,
            message_id,
            MAX_PROXIMITY_TTL_HOPS,
            status,
            text,
            signer,
        )?;
        let verified = frame.verified_for_organisation(
            organisation_id,
            beacon,
            &self.allowed_roster,
            verifier,
        )?;
        let wire = frame.encode()?;
        if self.replay_guard.contains(&message_id) || self.mesh_queue.contains(&message_id) {
            return Err(CoreError::ReplayDetected);
        }
        if !self.roster.can_observe(&verified)? {
            return Err(CoreError::StaleFrame);
        }
        if !self.mesh_queue.enqueue_local(&verified) {
            return Err(CoreError::CapacityExceeded);
        }
        self.roster.observe(&verified)?;
        self.replay_guard.accept_once(message_id);
        Ok(wire)
    }

    pub fn ingest_org_bound_peer_frame(
        &mut self,
        organisation_id: &OrganisationId,
        observed_beacon: [u8; 8],
        now_unix_secs: u64,
        raw_frame: &[u8],
        verifier: &dyn SignatureVerifier,
    ) -> Result<Option<ProximityFrame>, CoreError> {
        let candidates = [
            now_unix_secs.saturating_sub(300),
            now_unix_secs,
            now_unix_secs.saturating_add(300),
        ];
        let beacon_matches = candidates.iter().any(|&ts| {
            let expected = compute_proximity_beacon(&self.org_beacon_salt, ts);
            constant_time_eq_8(&observed_beacon, &expected)
        });
        if !beacon_matches {
            return Err(CoreError::UnauthorizedSender);
        }
        let verified = ProximityFrame::decode(raw_frame)?.verified_for_organisation_at(
            organisation_id,
            observed_beacon,
            &self.allowed_roster,
            verifier,
            now_unix_secs.saturating_mul(1000),
        )?;
        let frame = verified.frame();
        if self.replay_guard.contains(&frame.message_id) || !self.roster.can_observe(&verified)? {
            return Ok(None);
        }
        self.roster.observe(&verified)?;
        self.replay_guard.accept_once(frame.message_id);
        self.mesh_queue.enqueue_relay(&verified);
        Ok(Some(frame.clone()))
    }

    pub fn next_relay_batch(&mut self, max_frames: usize) -> Vec<Vec<u8>> {
        self.mesh_queue
            .drain(max_frames)
            .into_iter()
            .map(|frame| {
                frame
                    .encode()
                    .expect("verified queue entries remain valid after a hop decrement")
            })
            .collect()
    }

    /// Stable public-key order; each timestamp describes a historical check-in, not current safety.
    pub fn member_statuses(&self) -> Vec<(Ed25519PublicKey, SafetyStatus, String, u64)> {
        self.roster
            .statuses()
            .into_iter()
            .map(|member| {
                (
                    member.sender_public_key,
                    member.status,
                    member.text,
                    member.timestamp_ms,
                )
            })
            .collect()
    }

    /// Records the pseudonym a provisioned member picked. Trusted provisioning only: the key
    /// must already be in the roster and the handle inside the shared grammar. It changes what
    /// is displayed for that key and nothing else.
    pub fn provision_dedicated_handle(
        &mut self,
        sender_public_key: Ed25519PublicKey,
        raw_handle: &str,
    ) -> Result<(), CoreError> {
        if !self.allowed_roster.contains(&sender_public_key) {
            return Err(CoreError::UnauthorizedSender);
        }
        let handle = ProximityHandle::dedicated(raw_handle)?;
        self.dedicated_handles.insert(sender_public_key, handle);
        Ok(())
    }

    /// One display label per member that has checked in, in the order of
    /// [`Self::member_statuses`]. A handle is the member's dedicated pseudonym when one was
    /// provisioned, else derived from the sender key under this organisation's beacon salt.
    ///
    /// Equal handles are told apart with a fingerprint of the signing key keyed with this
    /// organisation's beacon salt (so it links nothing across organisations), and equality is judged
    /// over EVERY provisioned key, not over the members seen so far: a member whose handle equals
    /// that of someone who has not checked in yet already carries its fingerprint, so it cannot
    /// pass for the absent member and no label changes when that member appears. Labels are for
    /// display only: identity and admission stay with the key, the roster and the signature.
    pub fn member_labels(&self) -> Result<Vec<ProximityRosterLabel>, CoreError> {
        let provisioned: Vec<(Ed25519PublicKey, ProximityHandle)> =
            self.allowed_roster
                .iter()
                .map(|key| {
                    let handle =
                        self.dedicated_handles.get(key).cloned().unwrap_or_else(|| {
                            ProximityHandle::generated(&self.org_beacon_salt, key)
                        });
                    (*key, handle)
                })
                .collect();
        let observed: Vec<Ed25519PublicKey> = self
            .roster
            .statuses()
            .into_iter()
            .map(|member| member.sender_public_key)
            .collect();
        label_observed_proximity_senders(&self.org_beacon_salt, &provisioned, &observed)
    }
}

/// Rust-callable command seam; not registered with a running Tauri shell yet.
pub fn emit_proximity_checkin(
    node: &mut DesktopProximityNode,
    message_id: UuidV7,
    status: SafetyStatus,
    text: &str,
    signer: &dyn DeviceIdentitySigner,
    verifier: &dyn SignatureVerifier,
) -> Result<Vec<u8>, CoreError> {
    node.create_local_checkin(message_id, status, text, signer, verifier)
}

pub fn ingest_ble_frame(
    node: &mut DesktopProximityNode,
    observed_beacon: [u8; 8],
    now_unix_secs: u64,
    raw_frame: &[u8],
    verifier: &dyn SignatureVerifier,
) -> Result<Option<ProximityFrame>, CoreError> {
    node.ingest_peer_frame(observed_beacon, now_unix_secs, raw_frame, verifier)
}

pub fn get_proximity_roster_status(
    node: &DesktopProximityNode,
) -> Vec<(Ed25519PublicKey, SafetyStatus, String, u64)> {
    node.member_statuses()
}
