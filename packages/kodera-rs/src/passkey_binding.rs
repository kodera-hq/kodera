//! ES256 WebAuthn assertion verification for a trusted, pre-registered passkey credential.
//! Registration/attestation, platform association and protected persistence remain external.

use std::collections::BTreeMap;
use std::fmt;

use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine as _};
use p256::ecdsa::{signature::Verifier, Signature, VerifyingKey};
use serde::Deserialize;

use crate::{sha256, validate_docs_host, NativeCryptoError, OrganisationId};

const MAX_CHALLENGES: usize = 64;
const FLAG_UP: u8 = 0x01;
const FLAG_UV: u8 = 0x04;
const FLAG_BE: u8 = 0x08;
const FLAG_BS: u8 = 0x10;
const FLAG_AT: u8 = 0x40;
const FLAG_ED: u8 = 0x80;
const FLAG_RFU_MASK: u8 = 0x22;

/// Backup flag policy for WebAuthn Level 3 §6.5 assertion flags.
///
/// - [`Self::Universal`] (default): admits single-device security keys (`0x05`), backup-eligible
///   local passkeys (`0x0D`), and multi-device synced passkeys (`0x1D`, including platform keychains
///   and self-hosted software vaults) while still requiring `UP|UV` and rejecting invalid `BS=1, BE=0`
///   (`0x15`), attested-data (`AT`), extension (`ED`), and reserved (`RFU`) bits.
/// - [`Self::StrictNonBackupable`]: additionally requires `(flags & 0x18) == 0` (`0x05`).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub enum PasskeyBackupPolicy {
    #[default]
    Universal,
    StrictNonBackupable,
}

/// Authenticator backup/residency posture reported by signed WebAuthn Level 3 assertion flags.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum PasskeyResidencyPosture {
    SingleDeviceBound,
    BackupEligibleLocal,
    MultiDeviceSynced,
}

/// Sensitive correlation material; the bytes are passed to the platform authenticator.
#[derive(Clone)]
pub struct PasskeyChallenge {
    organisation: OrganisationId,
    nonce: [u8; 32],
    expires_at: u64,
}

impl fmt::Debug for PasskeyChallenge {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str("PasskeyChallenge([redacted])")
    }
}

impl PasskeyChallenge {
    pub fn as_bytes(&self) -> &[u8; 32] {
        &self.nonce
    }
    pub fn base64url(&self) -> String {
        URL_SAFE_NO_PAD.encode(self.nonce)
    }
}

/// Raw authenticator response. No client-side boolean establishes successful authentication.
pub struct PasskeyAssertion {
    pub credential_id: Vec<u8>,
    pub client_data_json: Vec<u8>,
    pub authenticator_data: Vec<u8>,
    pub signature_der: Vec<u8>,
}

impl fmt::Debug for PasskeyAssertion {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str("PasskeyAssertion([redacted])")
    }
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
struct ClientData {
    #[serde(rename = "type")]
    ceremony: String,
    challenge: String,
    origin: String,
    #[serde(default)]
    cross_origin: bool,
}

struct ChallengeState {
    expires_at: u64,
    used: bool,
}

/// The public key must come from trusted registration/attestation, never an assertion payload.
/// Requires `UP+UV` (`0x05`) and enforces [`PasskeyBackupPolicy`] (`Universal` by default: `0x05`,
/// `0x0D`, `0x1D`, rejecting invalid `BS=1, BE=0` `0x15`, `AT`, `ED`, and RFU bits).
/// Signed flags do not themselves prove a hardware manufacturer or secure-element residency.
pub struct PasskeyBinding {
    organisation: OrganisationId,
    rp_id: String,
    origin: String,
    credential_id: Vec<u8>,
    public_key: VerifyingKey,
    backup_policy: PasskeyBackupPolicy,
    last_counter: u32,
    latest_now: u64,
    last_residency_posture: Option<PasskeyResidencyPosture>,
    challenges: BTreeMap<[u8; 32], ChallengeState>,
}

impl fmt::Debug for PasskeyBinding {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str("PasskeyBinding([redacted])")
    }
}

fn validate_assertion_flags(
    flags: u8,
    policy: PasskeyBackupPolicy,
) -> Result<PasskeyResidencyPosture, NativeCryptoError> {
    if (flags & (FLAG_UP | FLAG_UV)) != (FLAG_UP | FLAG_UV) {
        return Err(NativeCryptoError::AuthenticationFailed);
    }
    if (flags & (FLAG_RFU_MASK | FLAG_AT | FLAG_ED)) != 0 {
        return Err(NativeCryptoError::AuthenticationFailed);
    }
    let backup_bits = flags & (FLAG_BE | FLAG_BS);
    if backup_bits == FLAG_BS {
        return Err(NativeCryptoError::AuthenticationFailed);
    }
    if policy == PasskeyBackupPolicy::StrictNonBackupable && backup_bits != 0 {
        return Err(NativeCryptoError::AuthenticationFailed);
    }
    Ok(match backup_bits {
        0 => PasskeyResidencyPosture::SingleDeviceBound,
        FLAG_BE => PasskeyResidencyPosture::BackupEligibleLocal,
        _ => PasskeyResidencyPosture::MultiDeviceSynced,
    })
}

fn admitted_origin(rp_id: &str, origin: &str) -> bool {
    if origin.len() > 512 {
        return false;
    }
    if let Some(host) = origin.strip_prefix("https://") {
        return validate_docs_host(host).is_ok()
            && (host == rp_id
                || host
                    .strip_suffix(rp_id)
                    .is_some_and(|prefix| prefix.ends_with('.')));
    }
    if let Some(hash) = origin.strip_prefix("android:apk-key-hash:") {
        return URL_SAFE_NO_PAD
            .decode(hash)
            .is_ok_and(|bytes| bytes.len() == 32 && URL_SAFE_NO_PAD.encode(bytes) == hash);
    }
    false
}

impl PasskeyBinding {
    /// Public origin and RP data come from the reviewed platform association policy.
    /// Defaults to [`PasskeyBackupPolicy::Universal`] so standard multi-provider WebAuthn L3
    /// passkeys (`0x05`, `0x0D`, `0x1D`) verify without vendor lock-in.
    pub fn new(
        organisation: OrganisationId,
        rp_id: &str,
        origin: &str,
        credential_id: &[u8],
        public_sec1_key: &[u8],
    ) -> Result<Self, NativeCryptoError> {
        Self::with_backup_policy(
            organisation,
            rp_id,
            origin,
            credential_id,
            public_sec1_key,
            PasskeyBackupPolicy::Universal,
        )
    }

    /// Creates an assertion verifier with an explicit [`PasskeyBackupPolicy`].
    pub fn with_backup_policy(
        organisation: OrganisationId,
        rp_id: &str,
        origin: &str,
        credential_id: &[u8],
        public_sec1_key: &[u8],
        backup_policy: PasskeyBackupPolicy,
    ) -> Result<Self, NativeCryptoError> {
        if validate_docs_host(rp_id).is_err()
            || !admitted_origin(rp_id, origin)
            || credential_id.is_empty()
            || credential_id.len() > 1024
            || !matches!(public_sec1_key.len(), 33 | 65)
        {
            return Err(NativeCryptoError::InvalidInput);
        }
        let public_key = VerifyingKey::from_sec1_bytes(public_sec1_key)
            .map_err(|_| NativeCryptoError::InvalidInput)?;
        Ok(Self {
            organisation,
            rp_id: rp_id.to_owned(),
            origin: origin.to_owned(),
            credential_id: credential_id.to_vec(),
            public_key,
            backup_policy,
            last_counter: 0,
            latest_now: 0,
            last_residency_posture: None,
            challenges: BTreeMap::new(),
        })
    }

    pub fn backup_policy(&self) -> PasskeyBackupPolicy {
        self.backup_policy
    }

    pub fn last_residency_posture(&self) -> Option<PasskeyResidencyPosture> {
        self.last_residency_posture
    }

    /// OS entropy supplies each 256-bit challenge. The trusted adapter supplies the clock.
    pub fn issue_challenge(
        &mut self,
        organisation: &OrganisationId,
        now: u64,
        lifetime_seconds: u64,
    ) -> Result<PasskeyChallenge, NativeCryptoError> {
        if organisation != &self.organisation {
            return Err(NativeCryptoError::ScopeMismatch);
        }
        if now < self.latest_now {
            return Err(NativeCryptoError::EpochMismatch);
        }
        if !(1..=300).contains(&lifetime_seconds) {
            return Err(NativeCryptoError::InvalidInput);
        }
        let expires_at = now
            .checked_add(lifetime_seconds)
            .ok_or(NativeCryptoError::InvalidInput)?;
        let retained = self
            .challenges
            .values()
            .filter(|state| state.expires_at >= now)
            .count();
        if retained == MAX_CHALLENGES {
            return Err(NativeCryptoError::Capacity);
        }
        let mut nonce = [0; 32];
        getrandom::fill(&mut nonce).map_err(|_| NativeCryptoError::AuthenticationFailed)?;
        if self.challenges.contains_key(&nonce) {
            return Err(NativeCryptoError::Replay);
        }
        self.challenges.retain(|_, state| state.expires_at >= now);
        self.challenges.insert(
            nonce,
            ChallengeState {
                expires_at,
                used: false,
            },
        );
        self.latest_now = now;
        Ok(PasskeyChallenge {
            organisation: self.organisation.clone(),
            nonce,
            expires_at,
        })
    }

    /// Verify the actual signature over authenticatorData || SHA256(clientDataJSON).
    /// Consume a challenge and advance the signed counter only after all checks pass.
    pub fn verify_assertion(
        &mut self,
        organisation: &OrganisationId,
        challenge: &PasskeyChallenge,
        assertion: &PasskeyAssertion,
        now: u64,
    ) -> Result<(), NativeCryptoError> {
        self.verify_assertion_posture(organisation, challenge, assertion, now)
            .map(|_| ())
    }

    /// Verify the assertion and return the authenticated [`PasskeyResidencyPosture`].
    pub fn verify_assertion_posture(
        &mut self,
        organisation: &OrganisationId,
        challenge: &PasskeyChallenge,
        assertion: &PasskeyAssertion,
        now: u64,
    ) -> Result<PasskeyResidencyPosture, NativeCryptoError> {
        if organisation != &self.organisation || challenge.organisation != self.organisation {
            return Err(NativeCryptoError::ScopeMismatch);
        }
        if now < self.latest_now {
            return Err(NativeCryptoError::EpochMismatch);
        }
        let state = self
            .challenges
            .get(&challenge.nonce)
            .ok_or(NativeCryptoError::AuthenticationFailed)?;
        if state.used {
            return Err(NativeCryptoError::Replay);
        }
        self.latest_now = now;
        if now > state.expires_at || state.expires_at != challenge.expires_at {
            return Err(NativeCryptoError::AuthenticationFailed);
        }
        if assertion.credential_id != self.credential_id
            || assertion.client_data_json.is_empty()
            || assertion.client_data_json.len() > 4096
            || assertion.authenticator_data.len() != 37
            || !(8..=80).contains(&assertion.signature_der.len())
        {
            return Err(NativeCryptoError::InvalidInput);
        }
        let client: ClientData = serde_json::from_slice(&assertion.client_data_json)
            .map_err(|_| NativeCryptoError::InvalidInput)?;
        let nonce = URL_SAFE_NO_PAD
            .decode(&client.challenge)
            .map_err(|_| NativeCryptoError::AuthenticationFailed)?;
        if client.ceremony != "webauthn.get"
            || client.origin != self.origin
            || client.cross_origin
            || nonce != challenge.nonce
            || URL_SAFE_NO_PAD.encode(&nonce) != client.challenge
        {
            return Err(NativeCryptoError::ScopeMismatch);
        }
        let data = &assertion.authenticator_data;
        if data[..32] != sha256(self.rp_id.as_bytes()) {
            return Err(NativeCryptoError::AuthenticationFailed);
        }
        let posture = validate_assertion_flags(data[32], self.backup_policy)?;
        let counter = u32::from_be_bytes(
            data[33..37]
                .try_into()
                .map_err(|_| NativeCryptoError::InvalidInput)?,
        );
        if (counter > 0 || self.last_counter > 0) && counter <= self.last_counter {
            return Err(NativeCryptoError::Replay);
        }
        let signature = Signature::from_der(&assertion.signature_der)
            .map_err(|_| NativeCryptoError::AuthenticationFailed)?;
        let mut signed = data.to_vec();
        signed.extend_from_slice(&sha256(&assertion.client_data_json));
        self.public_key
            .verify(&signed, &signature)
            .map_err(|_| NativeCryptoError::AuthenticationFailed)?;
        self.challenges
            .get_mut(&challenge.nonce)
            .ok_or(NativeCryptoError::AuthenticationFailed)?
            .used = true;
        self.last_counter = counter;
        self.last_residency_posture = Some(posture);
        Ok(posture)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use p256::ecdsa::{signature::Signer, SigningKey};

    fn org() -> OrganisationId {
        OrganisationId::parse("00000000-0000-4000-8000-000000000001").unwrap()
    }
    fn setup() -> (PasskeyBinding, SigningKey) {
        let signer = loop {
            let mut material = [0u8; 32];
            getrandom::fill(&mut material).unwrap();
            if let Ok(signer) = SigningKey::from_bytes(&material.into()) {
                break signer;
            }
        };
        let key = signer.verifying_key().to_sec1_point(false);
        let binding = PasskeyBinding::new(
            org(),
            "accounts.example.test",
            "https://accounts.example.test",
            b"public-fixture-credential",
            key.as_bytes(),
        )
        .unwrap();
        (binding, signer)
    }

    fn assertion(
        signer: &SigningKey,
        challenge: &PasskeyChallenge,
        count: u32,
        flags: u8,
        origin: &str,
    ) -> PasskeyAssertion {
        let client_data_json =
            serde_json::to_vec(&serde_json::json!({"type":"webauthn.get", "origin":origin,
            "challenge":challenge.base64url(), "crossOrigin":false}))
            .unwrap();
        let mut data = sha256(b"accounts.example.test").to_vec();
        data.push(flags);
        data.extend_from_slice(&count.to_be_bytes());
        let mut signed = data.clone();
        signed.extend_from_slice(&sha256(&client_data_json));
        let signature: Signature = signer.sign(&signed);
        PasskeyAssertion {
            credential_id: b"public-fixture-credential".to_vec(),
            client_data_json,
            authenticator_data: data,
            signature_der: signature.to_der().as_bytes().to_vec(),
        }
    }

    fn resign(signer: &SigningKey, response: &mut PasskeyAssertion) {
        let mut signed = response.authenticator_data.clone();
        signed.extend_from_slice(&sha256(&response.client_data_json));
        let signature: Signature = signer.sign(&signed);
        response.signature_der = signature.to_der().as_bytes().to_vec();
    }

    #[test]
    fn signed_rp_origin_challenge_and_strict_json_mutations_do_not_consume_a_good_response() {
        let (mut binding, signer) = setup();
        let challenge = binding.issue_challenge(&org(), 100, 30).unwrap();
        for mutation in 0..6 {
            let mut response = assertion(
                &signer,
                &challenge,
                1,
                0x05,
                "https://accounts.example.test",
            );
            if mutation == 0 {
                response.authenticator_data[..32].copy_from_slice(&sha256(b"foreign.example.test"));
            } else if mutation == 5 {
                let raw = String::from_utf8(response.client_data_json).unwrap();
                response.client_data_json = format!(
                    "{},\"\\u0074ype\":\"webauthn.get\"}}",
                    raw.trim_end_matches('}')
                )
                .into_bytes();
            } else {
                let mut client: serde_json::Value =
                    serde_json::from_slice(&response.client_data_json).unwrap();
                match mutation {
                    1 => client["crossOrigin"] = serde_json::json!(true),
                    2 => client["crossOrigin"] = serde_json::Value::Null,
                    3 => client["unreviewedField"] = serde_json::json!("present"),
                    4 => client["challenge"] = serde_json::json!(URL_SAFE_NO_PAD.encode([9u8; 32])),
                    _ => unreachable!(),
                }
                response.client_data_json = serde_json::to_vec(&client).unwrap();
            }
            resign(&signer, &mut response);
            let expected = if mutation == 0 {
                NativeCryptoError::AuthenticationFailed
            } else if matches!(mutation, 1 | 4) {
                NativeCryptoError::ScopeMismatch
            } else {
                NativeCryptoError::InvalidInput
            };
            assert_eq!(
                binding.verify_assertion(&org(), &challenge, &response, 101),
                Err(expected)
            );
        }
        let good = assertion(
            &signer,
            &challenge,
            1,
            0x05,
            "https://accounts.example.test",
        );
        binding
            .verify_assertion(&org(), &challenge, &good, 101)
            .unwrap();
    }

    #[test]
    fn exact_android_public_facet_and_zero_counters_still_require_each_new_challenge() {
        let (_, signer) = setup();
        let facet = format!("android:apk-key-hash:{}", URL_SAFE_NO_PAD.encode([9u8; 32]));
        let key = signer.verifying_key().to_sec1_point(false);
        let mut binding = PasskeyBinding::new(
            org(),
            "accounts.example.test",
            &facet,
            b"public-fixture-credential",
            key.as_bytes(),
        )
        .unwrap();
        let first = binding.issue_challenge(&org(), 100, 30).unwrap();
        let first_response = assertion(&signer, &first, 0, 0x05, &facet);
        binding
            .verify_assertion(&org(), &first, &first_response, 101)
            .unwrap();
        let second = binding.issue_challenge(&org(), 102, 30).unwrap();
        assert_eq!(
            binding.verify_assertion(&org(), &second, &first_response, 102),
            Err(NativeCryptoError::ScopeMismatch)
        );
        let second_response = assertion(&signer, &second, 0, 0x05, &facet);
        binding
            .verify_assertion(&org(), &second, &second_response, 102)
            .unwrap();
        assert!(!admitted_origin(
            "accounts.example.test",
            &format!("android:apk-key-hash:{}", "A".repeat(513))
        ));
    }

    #[test]
    fn real_es256_verification_consumes_only_authenticated_challenges_and_counters() {
        let (mut binding, signer) = setup();
        let challenge = binding.issue_challenge(&org(), 100, 30).unwrap();
        let mut response = assertion(
            &signer,
            &challenge,
            1,
            0x05,
            "https://accounts.example.test",
        );
        response.signature_der[10] ^= 1;
        assert_eq!(
            binding.verify_assertion(&org(), &challenge, &response, 101),
            Err(NativeCryptoError::AuthenticationFailed)
        );
        let good = assertion(
            &signer,
            &challenge,
            1,
            0x05,
            "https://accounts.example.test",
        );
        binding
            .verify_assertion(&org(), &challenge, &good, 101)
            .unwrap();
        assert_eq!(
            binding.verify_assertion(&org(), &challenge, &good, 101),
            Err(NativeCryptoError::Replay)
        );
        let next = binding.issue_challenge(&org(), 102, 30).unwrap();
        let stale = assertion(&signer, &next, 1, 0x05, "https://accounts.example.test");
        assert_eq!(
            binding.verify_assertion(&org(), &next, &stale, 103),
            Err(NativeCryptoError::Replay)
        );
        let good = assertion(&signer, &next, 2, 0x05, "https://accounts.example.test");
        binding.verify_assertion(&org(), &next, &good, 103).unwrap();
    }

    #[test]
    fn universal_policy_admits_single_device_backup_eligible_and_synced_passkeys_and_refuses_invalid_flags(
    ) {
        let (mut binding, signer) = setup();
        assert_eq!(binding.backup_policy(), PasskeyBackupPolicy::Universal);
        assert_eq!(binding.last_residency_posture(), None);

        let challenge = binding.issue_challenge(&org(), 100, 30).unwrap();
        for flags in [0x00, 0x01, 0x04, 0x09, 0x15, 0x19, 0x25, 0x45, 0x85] {
            let response = assertion(
                &signer,
                &challenge,
                1,
                flags,
                "https://accounts.example.test",
            );
            assert_eq!(
                binding.verify_assertion(&org(), &challenge, &response, 101),
                Err(NativeCryptoError::AuthenticationFailed),
                "unexpected acceptance for flags 0x{flags:02x}"
            );
        }

        for (step, (flags, expected_posture)) in [
            (0x05, PasskeyResidencyPosture::SingleDeviceBound),
            (0x0d, PasskeyResidencyPosture::BackupEligibleLocal),
            (0x1d, PasskeyResidencyPosture::MultiDeviceSynced),
        ]
        .into_iter()
        .enumerate()
        {
            let now = 102 + (step as u64) * 2;
            let c = binding.issue_challenge(&org(), now, 30).unwrap();
            let resp = assertion(
                &signer,
                &c,
                (step as u32) + 1,
                flags,
                "https://accounts.example.test",
            );
            let posture = binding
                .verify_assertion_posture(&org(), &c, &resp, now + 1)
                .unwrap();
            assert_eq!(posture, expected_posture);
            assert_eq!(binding.last_residency_posture(), Some(expected_posture));
        }
    }

    #[test]
    fn strict_non_backupable_policy_scope_origin_uv_expiry_and_clock_refusals_are_real_signed_assertions(
    ) {
        let (_, signer) = setup();
        let key = signer.verifying_key().to_sec1_point(false);
        let mut binding = PasskeyBinding::with_backup_policy(
            org(),
            "accounts.example.test",
            "https://accounts.example.test",
            b"public-fixture-credential",
            key.as_bytes(),
            PasskeyBackupPolicy::StrictNonBackupable,
        )
        .unwrap();
        let challenge = binding.issue_challenge(&org(), 100, 30).unwrap();
        for flags in [0x00, 0x01, 0x04, 0x0d, 0x15, 0x1d, 0x45, 0x85] {
            let response = assertion(
                &signer,
                &challenge,
                1,
                flags,
                "https://accounts.example.test",
            );
            assert_eq!(
                binding.verify_assertion(&org(), &challenge, &response, 101),
                Err(NativeCryptoError::AuthenticationFailed)
            );
        }
        let wrong_origin = assertion(&signer, &challenge, 1, 0x05, "https://foreign.example.test");
        assert_eq!(
            binding.verify_assertion(&org(), &challenge, &wrong_origin, 101),
            Err(NativeCryptoError::ScopeMismatch)
        );
        let good = assertion(
            &signer,
            &challenge,
            1,
            0x05,
            "https://accounts.example.test",
        );
        let foreign = OrganisationId::parse("00000000-0000-4000-8000-000000000002").unwrap();
        assert_eq!(
            binding.verify_assertion(&foreign, &challenge, &good, 101),
            Err(NativeCryptoError::ScopeMismatch)
        );
        assert_eq!(
            binding.verify_assertion(&org(), &challenge, &good, 131),
            Err(NativeCryptoError::AuthenticationFailed)
        );
        assert_eq!(
            binding.verify_assertion(&org(), &challenge, &good, 101),
            Err(NativeCryptoError::EpochMismatch)
        );
        assert!(format!("{binding:?} {challenge:?} {good:?}").contains("[redacted]"));
    }
}
