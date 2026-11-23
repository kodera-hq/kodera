use super::*;
use crate::{
    derive_extension_webhook_secret, preflight_self_host_spec, CloudProvider,
    DeployValidationError, DesktopWorkspaceSession, ProximityOrganisationKeyGuard,
    ScopedWebhookVerifierRegistry,
};
use kodera_rs::{
    hmac_sha256, DeviceIdentitySigner, Ed25519Signature, ExtensionWebhookVerifier, SafetyStatus,
    UuidV7,
};

const ORG: &str = "019a5e62-6ca0-7303-8303-030303030303";
const OTHER_ORG: &str = "019a5e62-6ca0-7303-8303-030303030304";

struct TestSigner {
    key: [u8; 32],
    pk: Ed25519PublicKey,
}

impl DeviceIdentitySigner for TestSigner {
    fn public_key(&self) -> Ed25519PublicKey {
        self.pk
    }
    fn sign(&self, message: &[u8]) -> Result<Ed25519Signature, CoreError> {
        let mac = hmac_sha256(&self.key, message);
        let mut sig = [0u8; 64];
        sig[0..32].copy_from_slice(&mac);
        sig[32..64].copy_from_slice(&mac);
        Ok(sig)
    }
}

impl SignatureVerifier for TestSigner {
    fn verify(
        &self,
        public_key: &Ed25519PublicKey,
        message: &[u8],
        signature: &Ed25519Signature,
    ) -> Result<(), CoreError> {
        if public_key != &self.pk {
            return Err(CoreError::UnauthorizedSender);
        }
        let expected = self.sign(message)?;
        if &expected != signature {
            return Err(CoreError::InvalidSignature);
        }
        Ok(())
    }
}

#[test]
fn bridges_kodera_rs_proximity_frame_validation() {
    let salt = [0x55u8; 32];
    let now = 1_762_520_000;
    let beacon = compute_proximity_beacon(&salt, now);
    let signer = TestSigner {
        key: [0x99; 32],
        pk: [0x11; 32],
    };
    let msg_id = UuidV7::from_parts(now * 1000, [1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
    let frame = ProximityFrame::new_signed(msg_id, 3, SafetyStatus::Safe, "Floor 3 clear", &signer)
        .expect("sign");
    let wire = frame.encode().expect("encode");

    let mut roster = HashSet::new();
    roster.insert(signer.pk);
    let mut guard = ProximityReplayGuard::new(64);

    let accepted =
        verify_incoming_proximity_packet(beacon, &salt, now, &wire, &roster, &signer, &mut guard)
            .expect("valid")
            .expect("first delivery");
    assert_eq!(accepted.text, "Floor 3 clear");

    // Duplicate delivery is suppressed by replay guard
    let duplicate =
        verify_incoming_proximity_packet(beacon, &salt, now, &wire, &roster, &signer, &mut guard)
            .expect("valid");
    assert!(duplicate.is_none());
}

fn test_signer(byte: u8) -> TestSigner {
    TestSigner {
        key: [byte.wrapping_add(1); 32],
        pk: [byte; 32],
    }
}

fn frame(signer: &TestSigner, timestamp: u64, ttl: u8, status: SafetyStatus) -> ProximityFrame {
    ProximityFrame::new_signed(
        UuidV7::from_parts(timestamp, [3; 10]),
        ttl,
        status,
        "check-in",
        signer,
    )
    .unwrap()
}

fn node(signers: &[&TestSigner], capacity: usize) -> DesktopProximityNode {
    DesktopProximityNode::new([0x42; 32], signers.iter().map(|s| s.pk).collect(), capacity).unwrap()
}

struct PairVerifier<'a>(&'a TestSigner, &'a TestSigner);
impl SignatureVerifier for PairVerifier<'_> {
    fn verify(
        &self,
        pk: &Ed25519PublicKey,
        message: &[u8],
        sig: &Ed25519Signature,
    ) -> Result<(), CoreError> {
        if pk == &self.0.pk {
            self.0.verify(pk, message, sig)
        } else {
            self.1.verify(pk, message, sig)
        }
    }
}

#[test]
fn relay_chain_decrements_three_to_two_to_one_and_stops() {
    let signer = test_signer(9);
    let now = 1_762_520_100;
    let wire3 = frame(&signer, now * 1000, 3, SafetyStatus::Safe)
        .encode()
        .unwrap();
    let mut first = node(&[&signer], 8);
    let mut second = node(&[&signer], 8);
    let mut third = node(&[&signer], 8);
    let beacon = first.current_beacon(now);
    assert_eq!(
        ingest_ble_frame(&mut first, beacon, now, &wire3, &signer)
            .unwrap()
            .unwrap()
            .ttl_hops,
        3
    );
    let wire2 = first.next_relay_batch(8).remove(0);
    assert_eq!(ProximityFrame::decode(&wire2).unwrap().ttl_hops, 2);
    second
        .ingest_peer_frame(beacon, now, &wire2, &signer)
        .unwrap();
    let wire1 = second.next_relay_batch(8).remove(0);
    assert_eq!(ProximityFrame::decode(&wire1).unwrap().ttl_hops, 1);
    third
        .ingest_peer_frame(beacon, now, &wire1, &signer)
        .unwrap();
    assert!(third.next_relay_batch(8).is_empty());
    assert_eq!(get_proximity_roster_status(&third)[0].1, SafetyStatus::Safe);
    assert!(first
        .ingest_peer_frame(beacon, now, &wire1, &signer)
        .unwrap()
        .is_none());
    assert!(first.next_relay_batch(8).is_empty());
}

#[test]
fn proximity_node_prioritizes_help_and_does_not_roll_status_back() {
    let safe = test_signer(9);
    let help = test_signer(10);
    let verifier = PairVerifier(&safe, &help);
    let mut node = node(&[&safe, &help], 4);
    let now = 1_762_520_100;
    let beacon = node.current_beacon(now);
    node.ingest_peer_frame(
        beacon,
        now,
        &frame(&safe, 20, 3, SafetyStatus::Safe).encode().unwrap(),
        &verifier,
    )
    .unwrap();
    node.ingest_peer_frame(
        beacon,
        now,
        &frame(&help, 19, 3, SafetyStatus::NeedAssistance)
            .encode()
            .unwrap(),
        &verifier,
    )
    .unwrap();
    let batch = node.next_relay_batch(9);
    assert_eq!(
        ProximityFrame::decode(&batch[0]).unwrap().status,
        SafetyStatus::NeedAssistance
    );
    assert_eq!(
        ProximityFrame::decode(&batch[1]).unwrap().status,
        SafetyStatus::Safe
    );
    let old = frame(&safe, 18, 3, SafetyStatus::NeedAssistance)
        .encode()
        .unwrap();
    assert!(node
        .ingest_peer_frame(beacon, now, &old, &verifier)
        .unwrap()
        .is_none());
    assert_eq!(node.member_statuses()[0].1, SafetyStatus::Safe);
    assert_eq!(node.member_statuses()[0].3, 20);
    assert!(node.next_relay_batch(9).is_empty());
}

#[test]
fn local_checkin_echo_is_suppressed_and_backend_preflight_redacts() {
    let signer = test_signer(9);
    let mut node = node(&[&signer], 4);
    let now = 1_762_520_100;
    let id = UuidV7::from_parts(now * 1000, [3; 10]);
    let wire = emit_proximity_checkin(&mut node, id, SafetyStatus::Safe, "Here", &signer, &signer)
        .unwrap();
    assert_eq!(
        ProximityFrame::decode(&wire).unwrap().ttl_hops,
        MAX_PROXIMITY_TTL_HOPS
    );
    assert_eq!(node.next_relay_batch(1), vec![wire.clone()]);
    assert!(node
        .ingest_peer_frame(node.current_beacon(now), now, &wire, &signer)
        .unwrap()
        .is_none());
    assert!(node.next_relay_batch(1).is_empty());
    assert_eq!(
        node.create_local_checkin(id, SafetyStatus::Safe, "Here", &signer, &signer),
        Err(CoreError::ReplayDetected)
    );
    assert_eq!(
        node.create_local_checkin(
            UuidV7::from_parts(now * 1000 - 1, [3; 10]),
            SafetyStatus::Safe,
            "Old",
            &signer,
            &signer
        ),
        Err(CoreError::StaleFrame)
    );
    let spec = preflight_self_host_spec(
        CloudProvider::Scaleway,
        "fr-par-1",
        "chat.example.test",
        "ops@example.test",
        "fixture_token_0123456789",
    )
    .unwrap();
    assert!(!format!("{spec:?}").contains("fixture_token_0123456789"));
    assert!(format!("{spec:?}").contains("REDACTED"));
    assert_eq!(
        preflight_self_host_spec(
            CloudProvider::Scaleway,
            "fr-par-1",
            "localhost",
            "ops@example.test",
            "fixture_token_0123456789"
        )
        .unwrap_err(),
        DeployValidationError::InvalidDomain
    );
    assert_eq!(
        preflight_self_host_spec(
            CloudProvider::Scaleway,
            "fr-par-1",
            "chat.example.test",
            "ops@example.test",
            "short"
        )
        .unwrap_err(),
        DeployValidationError::TokenTooShort
    );
}

#[test]
fn peer_frame_dated_past_the_skew_bound_is_refused_and_cannot_mask_real_check_ins() {
    let signer = test_signer(11);
    let mut node = node(&[&signer], 4);
    let now = 1_762_520_100;
    let beacon = node.current_beacon(now);
    let ahead = frame(
        &signer,
        now * 1000 + kodera_rs::MAX_PROXIMITY_FUTURE_SKEW_MS + 1,
        3,
        SafetyStatus::Safe,
    )
    .encode()
    .unwrap();
    assert_eq!(
        node.ingest_peer_frame(beacon, now, &ahead, &signer),
        Err(CoreError::FutureFrame)
    );
    assert!(node.member_statuses().is_empty());
    assert!(node.next_relay_batch(4).is_empty());
    let real = frame(&signer, now * 1000, 3, SafetyStatus::NeedAssistance)
        .encode()
        .unwrap();
    assert!(node
        .ingest_peer_frame(beacon, now, &real, &signer)
        .unwrap()
        .is_some());
    let at_bound = frame(
        &signer,
        now * 1000 + kodera_rs::MAX_PROXIMITY_FUTURE_SKEW_MS,
        3,
        SafetyStatus::Safe,
    )
    .encode()
    .unwrap();
    assert!(node
        .ingest_peer_frame(beacon, now, &at_bound, &signer)
        .unwrap()
        .is_some());
}

#[test]
fn invalid_packet_rejections_leave_state_and_replay_unmodified() {
    let signer = test_signer(9);
    let stranger = test_signer(10);
    let mut node = node(&[&signer], 4);
    let now = 1_762_520_100;
    let beacon = node.current_beacon(now);
    let wire = frame(&signer, now * 1000, 3, SafetyStatus::Safe)
        .encode()
        .unwrap();
    assert_eq!(
        node.ingest_peer_frame([0; 8], now, &wire, &signer),
        Err(CoreError::UnauthorizedSender)
    );
    let mut forged = wire.clone();
    forged[54] ^= 1;
    assert_eq!(
        node.ingest_peer_frame(beacon, now, &forged, &signer),
        Err(CoreError::InvalidSignature)
    );
    let outsider = frame(&stranger, now * 1000, 3, SafetyStatus::Safe)
        .encode()
        .unwrap();
    assert_eq!(
        node.ingest_peer_frame(beacon, now, &outsider, &stranger),
        Err(CoreError::UnauthorizedSender)
    );
    let mut invalid_ttl = wire.clone();
    invalid_ttl[51] = 0;
    assert_eq!(
        node.ingest_peer_frame(beacon, now, &invalid_ttl, &signer),
        Err(CoreError::InvalidTtl)
    );
    assert!(node.member_statuses().is_empty());
    assert!(node.next_relay_batch(4).is_empty());
    assert!(node
        .ingest_peer_frame(beacon, now, &wire, &signer)
        .unwrap()
        .is_some());
}

#[test]
fn beacon_tolerance_is_adjacent_bucket_only_and_node_state_is_per_instance() {
    let signer = test_signer(9);
    let now = 1_762_520_100;
    let wire = frame(&signer, now * 1000, 3, SafetyStatus::Safe)
        .encode()
        .unwrap();
    for delta in [-300_i64, 0, 300] {
        let mut node = node(&[&signer], 4);
        let beacon = compute_proximity_beacon(&[0x42; 32], (now as i64 + delta) as u64);
        assert!(node
            .ingest_peer_frame(beacon, now, &wire, &signer)
            .unwrap()
            .is_some());
    }
    let mut isolated =
        DesktopProximityNode::new([0x43; 32], HashSet::from([signer.pk]), 4).unwrap();
    let wrong_org_beacon = compute_proximity_beacon(&[0x42; 32], now);
    assert_eq!(
        isolated.ingest_peer_frame(wrong_org_beacon, now, &wire, &signer),
        Err(CoreError::UnauthorizedSender)
    );
    let distant = compute_proximity_beacon(&[0x43; 32], now + 600);
    assert_eq!(
        isolated.ingest_peer_frame(distant, now, &wire, &signer),
        Err(CoreError::UnauthorizedSender)
    );
    assert!(isolated.member_statuses().is_empty());
}

#[test]
fn v1_public_beacon_retagging_exposes_shared_signing_key_org_boundary() {
    let org_a = "11111111-1111-4111-8111-111111111111";
    let org_b = "22222222-2222-4222-8222-222222222222";
    let shared_signer = test_signer(9);
    let distinct_signer = test_signer(10);
    let now = 1_762_520_100;
    let mut sender =
        DesktopWorkspaceSession::new(org_a, [0x42; 32], HashSet::from([shared_signer.pk]), 4)
            .unwrap();
    let mut receiver =
        DesktopWorkspaceSession::new(org_b, [0x43; 32], HashSet::from([shared_signer.pk]), 4)
            .unwrap();
    let wire = sender
        .create_local_checkin(
            org_a,
            UuidV7::from_parts(now * 1000, [3; 10]),
            SafetyStatus::Safe,
            "Organisation A fixture",
            &shared_signer,
            &shared_signer,
        )
        .unwrap();
    let beacon_a = sender.current_beacon(org_a, now).unwrap();
    let beacon_b = receiver.current_beacon(org_b, now).unwrap();
    assert_ne!(beacon_a, beacon_b);
    assert_eq!(
        receiver.ingest_peer_frame(org_b, beacon_a, now, &wire, &shared_signer),
        Err(CoreError::UnauthorizedSender)
    );
    assert_eq!(
        receiver.ingest_peer_frame(org_a, beacon_b, now, &wire, &shared_signer),
        Err(CoreError::OrganisationMismatch)
    );
    assert!(receiver.member_statuses(org_b).unwrap().is_empty());

    // A public target beacon can be substituted without changing signed frame bytes.
    // This pins a v1 activation limitation, not successful cross-org authorisation.
    let accepted = receiver
        .ingest_peer_frame(org_b, beacon_b, now, &wire, &shared_signer)
        .unwrap()
        .unwrap();
    assert_eq!(accepted.text, "Organisation A fixture");
    assert_eq!(accepted.sender_public_key, shared_signer.pk);
    assert_eq!(receiver.member_statuses(org_b).unwrap().len(), 1);
    let relayed = receiver.next_relay_batch(org_b, 1).unwrap();
    assert_eq!(relayed.len(), 1);
    let relay = ProximityFrame::decode(&relayed[0]).unwrap();
    assert_eq!(relay.signature, accepted.signature);
    assert_eq!(relay.ttl_hops + 1, accepted.ttl_hops);

    // Target roster separation still rejects the same retagged packet before admission.
    let mut disjoint =
        DesktopWorkspaceSession::new(org_b, [0x43; 32], HashSet::from([distinct_signer.pk]), 4)
            .unwrap();
    assert_eq!(
        disjoint.ingest_peer_frame(org_b, beacon_b, now, &wire, &shared_signer),
        Err(CoreError::UnauthorizedSender)
    );
    assert!(disjoint.member_statuses(org_b).unwrap().is_empty());
    assert!(disjoint.next_relay_batch(org_b, 1).unwrap().is_empty());
}

#[test]
fn org_bound_proximity_and_scoped_webhooks_reject_cross_org_retagging_and_secret_reuse() {
    let org_a = "11111111-1111-4111-8111-111111111111";
    let org_b = "22222222-2222-4222-8222-222222222222";
    let shared_signer = test_signer(9);
    let now = 1_762_520_100;

    // 1. ProximityOrganisationKeyGuard rejects registering the same Ed25519 key across orgs
    let mut key_guard = ProximityOrganisationKeyGuard::new();
    let beacon_a = compute_proximity_beacon(&[0x42; 32], now);
    let beacon_b = compute_proximity_beacon(&[0x43; 32], now);
    key_guard
        .register_roster(
            OrganisationId::parse(org_a).unwrap(),
            beacon_a,
            HashSet::from([shared_signer.pk]),
        )
        .unwrap();
    assert_eq!(
        key_guard.register_roster(
            OrganisationId::parse(org_b).unwrap(),
            beacon_b,
            HashSet::from([shared_signer.pk]),
        ),
        Err(CoreError::UnauthorizedSender)
    );

    // 2. Context-bound create_org_bound_checkin / ingest_org_bound_peer_frame rejects beacon retagging
    let mut sender =
        DesktopWorkspaceSession::new(org_a, [0x42; 32], HashSet::from([shared_signer.pk]), 4)
            .unwrap();
    let mut receiver =
        DesktopWorkspaceSession::new(org_b, [0x43; 32], HashSet::from([shared_signer.pk]), 4)
            .unwrap();
    let wire = sender
        .create_org_bound_checkin(
            org_a,
            now,
            UuidV7::from_parts(now * 1000, [3; 10]),
            SafetyStatus::Safe,
            "Org-bound fixture",
            &shared_signer,
            &shared_signer,
        )
        .unwrap();
    assert_eq!(
        receiver.ingest_org_bound_peer_frame(org_b, beacon_b, now, &wire, &shared_signer),
        Err(CoreError::InvalidSignature)
    );
    assert!(receiver.member_statuses(org_b).unwrap().is_empty());

    // 3. Context-bound verify_scoped_extension_webhook & ScopedWebhookVerifierRegistry reject secret reuse
    let secret = [0x42; 32];
    let delivery = UuidV7::from_parts(now * 1000, [4; 10]);
    let payload = b"{\"ok\":true}";
    let derived =
        derive_extension_webhook_secret(&secret, &OrganisationId::parse(org_a).unwrap(), "docs")
            .unwrap();
    assert_ne!(derived, secret);
    let sig_a = ExtensionWebhookVerifier::sign_scoped_payload(
        &OrganisationId::parse(org_a).unwrap(),
        "docs",
        delivery,
        now,
        &secret,
        payload,
    )
    .unwrap();
    sender
        .verify_scoped_extension_webhook(
            org_a, "docs", delivery, now, now, &secret, payload, &sig_a,
        )
        .unwrap();
    assert_eq!(
        sender.verify_scoped_extension_webhook(
            org_a, "other", delivery, now, now, &secret, payload, &sig_a
        ),
        Err(CoreError::InvalidSignature)
    );
    assert_eq!(
        receiver.verify_scoped_extension_webhook(
            org_b, "docs", delivery, now, now, &secret, payload, &sig_a
        ),
        Err(CoreError::InvalidSignature)
    );
    let mut registry = ScopedWebhookVerifierRegistry::new(4).unwrap();
    registry
        .register_extension_secret(OrganisationId::parse(org_a).unwrap(), "docs", &secret)
        .unwrap();
    assert_eq!(
        registry.register_extension_secret(OrganisationId::parse(org_b).unwrap(), "docs", &secret),
        Err(CoreError::UnauthorizedSender)
    );
}

#[test]
fn bounded_node_refuses_local_overflow_without_changing_member_status() {
    let safe = test_signer(9);
    let help = test_signer(10);
    let verifier = PairVerifier(&safe, &help);
    let mut node = node(&[&safe, &help], 1);
    node.create_local_checkin(
        UuidV7::from_parts(20, [3; 10]),
        SafetyStatus::NeedAssistance,
        "Help",
        &help,
        &verifier,
    )
    .unwrap();
    assert_eq!(
        node.create_local_checkin(
            UuidV7::from_parts(21, [3; 10]),
            SafetyStatus::Safe,
            "Safe",
            &safe,
            &verifier
        ),
        Err(CoreError::CapacityExceeded)
    );
    assert_eq!(node.member_statuses().len(), 1);
    assert_eq!(node.member_statuses()[0].0, help.pk);
    assert!(matches!(
        DesktopProximityNode::new([0x42; 32], HashSet::new(), 0),
        Err(CoreError::InvalidCapacity)
    ));
    let roster = (0..4097u32)
        .map(|value| {
            let mut key = [0; 32];
            key[..4].copy_from_slice(&value.to_be_bytes());
            key
        })
        .collect();
    assert!(matches!(
        DesktopProximityNode::new([0x42; 32], roster, 1),
        Err(CoreError::InvalidCapacity)
    ));
}

#[test]
fn failed_workspace_switch_leaves_no_old_session_and_node_clear_overwrites_salt() {
    let signer = test_signer(9);
    let mut node = node(&[&signer], 4);
    let id = UuidV7::from_parts(1, [3; 10]);
    node.create_local_checkin(id, SafetyStatus::Safe, "Here", &signer, &signer)
        .unwrap();
    node.clear();
    assert_eq!(node.org_beacon_salt, [0; 32]);
    assert!(node.allowed_roster.is_empty());
    assert!(!node.replay_guard.contains(&id));
    assert!(!node.mesh_queue.contains(&id));
    assert!(node.mesh_queue.is_empty());
    assert!(node.member_statuses().is_empty());
    for bad in [
        "",
        " org ",
        "00000000-0000-0000-0000-000000000000",
        "019A5e62-6ca0-7303-8303-030303030303",
    ] {
        assert!(matches!(
            DesktopWorkspaceSession::new(bad, [0x42; 32], HashSet::from([signer.pk]), 4),
            Err(CoreError::InvalidOrganisation)
        ));
    }
    let mut session =
        DesktopWorkspaceSession::new(ORG, [0x42; 32], HashSet::from([signer.pk]), 4).unwrap();
    assert_eq!(
        session.switch_organisation(OTHER_ORG, [0x43; 32], HashSet::from([signer.pk]), 0),
        Err(CoreError::InvalidCapacity)
    );
    assert!(session.proximity.is_none());
    assert_eq!(session.organisation_id(), None);
    assert_eq!(
        session.member_statuses(ORG),
        Err(CoreError::TransportUnavailable)
    );
}
