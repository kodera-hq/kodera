use super::*;
use kodera_rs::{hmac_sha256, DeviceIdentitySigner, Ed25519Signature, SafetyStatus, UuidV7};

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

fn test_signer(byte: u8) -> TestSigner {
    TestSigner {
        key: [byte.wrapping_add(1); 32],
        pk: [byte; 32],
    }
}

#[test]
fn docs_pad_bounds_match_shared_native_cases() {
    for line in
        include_str!("../../../../../packages/kodera-rs/tests/vectors/docs-pad/bounds.tsv").lines()
    {
        let fields: Vec<_> = line.split_whitespace().collect();
        let size: usize = fields[1].parse().unwrap();
        let expected = fields[2] == "true";
        let signer = TestSigner {
            key: [9; 32],
            pk: [9; 32],
        };
        let org = "11111111-1111-4111-8111-111111111111";
        let mut session =
            DesktopWorkspaceSession::new(org, [0x42; 32], HashSet::from([signer.pk]), 4).unwrap();
        let admitted = match fields[0] {
            "id" => session
                .save_docs_pad(org, &"a".repeat(size), "channel", "Title", "", "actor")
                .is_ok(),
            "count" => {
                size > 0
                    && (0..size).all(|i| {
                        session
                            .save_docs_pad(
                                org,
                                &format!("pad-{i}"),
                                "channel",
                                "Title",
                                "",
                                "actor",
                            )
                            .is_ok()
                    })
            }
            _ => panic!("unknown bounds case"),
        };
        assert_eq!(admitted, expected, "{line}");
        if fields[0] == "count" && size >= kodera_rs::MAX_DOCS_PADS {
            assert!(session
                .save_docs_pad(org, "pad-0", "channel", "Updated", "", "actor")
                .is_ok());
        }
    }
}

#[test]
fn workspace_switch_clears_roster_replay_queue_and_old_provisioning() {
    let signer = test_signer(9);
    let replacement = test_signer(10);
    let now = 1_762_520_100;
    let mut session =
        DesktopWorkspaceSession::new(ORG, [0x42; 32], HashSet::from([signer.pk]), 4).unwrap();
    let id = UuidV7::from_parts(now * 1000, [3; 10]);
    let wire = session
        .create_local_checkin(ORG, id, SafetyStatus::Safe, "Here", &signer, &signer)
        .unwrap();
    assert_eq!(session.member_statuses(ORG).unwrap().len(), 1);
    assert_eq!(session.proximity.as_ref().unwrap().mesh_queue.len(), 1);
    assert!(session
        .proximity
        .as_ref()
        .unwrap()
        .replay_guard
        .contains(&id));
    assert_eq!(
        session.member_statuses(OTHER_ORG),
        Err(CoreError::OrganisationMismatch)
    );
    assert_eq!(
        session.next_relay_batch(OTHER_ORG, 1),
        Err(CoreError::OrganisationMismatch)
    );
    let old_beacon = session.current_beacon(ORG, now).unwrap();
    session
        .switch_organisation(OTHER_ORG, [0x43; 32], HashSet::from([replacement.pk]), 4)
        .unwrap();
    assert_eq!(session.organisation_id(), Some(OTHER_ORG));
    assert_eq!(
        session.member_statuses(ORG),
        Err(CoreError::OrganisationMismatch)
    );
    assert!(session.member_statuses(OTHER_ORG).unwrap().is_empty());
    assert!(session.next_relay_batch(OTHER_ORG, 10).unwrap().is_empty());
    let new_beacon = session.current_beacon(OTHER_ORG, now).unwrap();
    assert_ne!(old_beacon, new_beacon);
    assert_eq!(
        session.ingest_peer_frame(OTHER_ORG, old_beacon, now, &wire, &signer),
        Err(CoreError::UnauthorizedSender)
    );
    assert_eq!(
        session.ingest_peer_frame(OTHER_ORG, new_beacon, now, &wire, &signer),
        Err(CoreError::UnauthorizedSender)
    );
    // Same ID is usable by a legitimately provisioned different organisation, not inherited replay.
    session
        .create_local_checkin(
            OTHER_ORG,
            id,
            SafetyStatus::Safe,
            "Here",
            &replacement,
            &replacement,
        )
        .unwrap();
    session.clear_session();
    assert_eq!(session.organisation_id(), None);
    assert!(session.proximity.is_none());
    assert_eq!(
        session.current_beacon(OTHER_ORG, now),
        Err(CoreError::TransportUnavailable)
    );
    assert_eq!(
        session.create_local_checkin(
            OTHER_ORG,
            id,
            SafetyStatus::Safe,
            "Here",
            &replacement,
            &replacement
        ),
        Err(CoreError::TransportUnavailable)
    );
    session.clear_session();
}

#[test]
fn docs_session_policy_is_explicit_org_bound_and_transactional() {
    let signer = test_signer(9);
    let mut session =
        DesktopWorkspaceSession::new(ORG, [0x42; 32], HashSet::from([signer.pk]), 4).unwrap();
    let url = "https://docs.example.org/docs/pad";
    assert_eq!(
        session.validate_docs_pad_url(ORG, url),
        Err(CoreError::TransportUnavailable)
    );
    assert_eq!(
        session.configure_docs_host(OTHER_ORG, Some("docs.example.org")),
        Err(CoreError::OrganisationMismatch)
    );
    assert!(session.allowed_docs_host.is_none());
    session
        .configure_docs_host(ORG, Some("docs.example.org"))
        .unwrap();
    assert_eq!(
        session.validate_docs_pad_url(ORG, url).unwrap().as_str(),
        url
    );
    assert_eq!(
        session.validate_docs_pad_url(OTHER_ORG, url),
        Err(CoreError::OrganisationMismatch)
    );
    assert_eq!(
        session.configure_docs_host(ORG, Some("localhost")),
        Err(CoreError::UntrustedDocsOrigin)
    );
    assert!(session.validate_docs_pad_url(ORG, url).is_ok());
    session.configure_docs_host(ORG, None).unwrap();
    assert_eq!(
        session.validate_docs_pad_url(ORG, url),
        Err(CoreError::TransportUnavailable)
    );
    session.clear_session();
    assert_eq!(
        session.configure_docs_host(ORG, Some("docs.example.org")),
        Err(CoreError::TransportUnavailable)
    );
}

#[test]
fn extension_session_auth_replay_and_docs_policy_reset_across_org_switches() {
    let signer = test_signer(9);
    let mut session =
        DesktopWorkspaceSession::new(ORG, [0x42; 32], HashSet::from([signer.pk]), 4).unwrap();
    let now = 1_762_520_100;
    let id = UuidV7::from_parts(now * 1000, [3; 10]);
    let payload = [0, 255, 10, 58, 65];
    let mac = "83ece4ff7a8e78097259ad7127fe1281cb706c7d4ab94e73779de45429707150";
    session
        .configure_docs_host(ORG, Some("docs.example.org"))
        .unwrap();
    assert_eq!(
        session.verify_extension_webhook(
            OTHER_ORG,
            "docs",
            id,
            now,
            now,
            &[0x42; 32],
            &payload,
            mac
        ),
        Err(CoreError::OrganisationMismatch)
    );
    assert_eq!(
        session.extension_webhooks.as_ref().unwrap().replay_count(),
        0
    );
    assert_eq!(
        session.verify_extension_webhook(ORG, "docs", id, now, now, &[0x43; 32], &payload, mac),
        Err(CoreError::InvalidSignature)
    );
    session
        .verify_extension_webhook(ORG, "docs", id, now, now, &[0x42; 32], &payload, mac)
        .unwrap();
    assert_eq!(
        session.verify_extension_webhook(ORG, "docs", id, now, now, &[0x42; 32], &payload, mac),
        Err(CoreError::ReplayDetected)
    );
    session
        .switch_organisation(OTHER_ORG, [0x43; 32], HashSet::from([signer.pk]), 4)
        .unwrap();
    assert!(session.allowed_docs_host.is_none());
    assert_eq!(
        session.extension_webhooks.as_ref().unwrap().replay_count(),
        0
    );
    assert_eq!(
        session.validate_docs_pad_url(OTHER_ORG, "https://docs.example.org/docs/a"),
        Err(CoreError::TransportUnavailable)
    );
    assert_eq!(
        session.verify_extension_webhook(ORG, "docs", id, now, now, &[0x42; 32], &payload, mac),
        Err(CoreError::OrganisationMismatch)
    );
    // The same fixture is accepted under an incorrectly reused secret: org identity is not
    // signed in this protocol. Real adapters must provision pair-specific secrets instead.
    session
        .verify_extension_webhook(OTHER_ORG, "docs", id, now, now, &[0x42; 32], &payload, mac)
        .unwrap();
    session.clear_session();
    assert!(session.allowed_docs_host.is_none());
    assert!(session.extension_webhooks.is_none());
    assert_eq!(
        session.verify_extension_webhook(
            OTHER_ORG,
            "docs",
            id,
            now,
            now,
            &[0x42; 32],
            &payload,
            mac
        ),
        Err(CoreError::TransportUnavailable)
    );
}

#[test]
fn failed_switch_clears_docs_and_extension_state_even_before_replacement_validation() {
    let signer = test_signer(9);
    let mut session =
        DesktopWorkspaceSession::new(ORG, [0x42; 32], HashSet::from([signer.pk]), 4).unwrap();
    session
        .configure_docs_host(ORG, Some("docs.example.org"))
        .unwrap();
    assert_eq!(
        session.switch_organisation("invalid", [0x43; 32], HashSet::from([signer.pk]), 4),
        Err(CoreError::InvalidOrganisation)
    );
    assert!(session.allowed_docs_host.is_none());
    assert!(session.extension_webhooks.is_none());
    assert!(session.organisation_id().is_none());
    assert_eq!(
        session.validate_docs_pad_url(ORG, "https://docs.example.org/docs/a"),
        Err(CoreError::TransportUnavailable)
    );
}

#[test]
fn desktop_proximity_session_system_clock_helpers_verify_present_and_reject_future() {
    let signer = test_signer(11);
    let mut session =
        DesktopWorkspaceSession::new(ORG, [0x42; 32], HashSet::from([signer.pk]), 4).unwrap();
    let beacon = session.current_beacon_now(ORG).unwrap();
    let now_ms = kodera_rs::system_unix_ms();
    let valid_wire = ProximityFrame::new_signed(
        UuidV7::from_parts(now_ms, [0x01; 10]),
        3,
        SafetyStatus::Safe,
        "present",
        &signer,
    )
    .unwrap()
    .encode()
    .unwrap();
    let accepted = session
        .ingest_peer_frame_now(ORG, beacon, &valid_wire, &signer)
        .unwrap();
    assert!(accepted.is_some());

    let future_wire = ProximityFrame::new_signed(
        UuidV7::from_parts(now_ms + 360_000, [0x02; 10]),
        3,
        SafetyStatus::Safe,
        "future",
        &signer,
    )
    .unwrap()
    .encode()
    .unwrap();
    assert_eq!(
        session.ingest_peer_frame_now(ORG, beacon, &future_wire, &signer),
        Err(CoreError::FutureFrame)
    );
}
