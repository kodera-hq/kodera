//! Closed, bounded statements for the confidential relay admission protocol.
//! This module never exposes the underlying signing operation.

use std::collections::BTreeMap;

use crate::OrganisationId;
use base64::{engine::general_purpose::STANDARD, Engine};
use serde_json::{json, Value};

use super::device::{OpenMlsDevice, PendingMlsPackageId};
use super::*;

pub(super) const MAX_JSON_INTEGER: u64 = (1 << 53) - 1;
const MAX_APPLICATION_CIPHERTEXT: usize = 81_920;
const MAX_HANDSHAKE_CIPHERTEXT: usize = 262_144;
const MAX_HTTP_BODY: usize = 768 * 1024;

/// A non-nil lowercase canonical UUID, with no alternate textual spelling.
#[derive(Clone, Debug, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub struct RelayId(String);

impl RelayId {
    pub fn parse(value: &str) -> Result<Self, NativeCryptoError> {
        // The public organisation type already enforces this UUID grammar.
        OrganisationId::parse(value).map_err(|_| NativeCryptoError::InvalidInput)?;
        Ok(Self(value.to_owned()))
    }

    pub fn as_str(&self) -> &str {
        &self.0
    }
}

#[cfg(test)]
mod tests {
    use super::super::device::{
        tests::{admitted, finish, fixture, room, scope, TestStore},
        MlsDeviceScope,
    };
    use super::*;
    use crate::UuidV7;
    use openmls_traits::crypto::OpenMlsCrypto;
    use std::io::Write;

    fn verify_public(own: &OpenMlsDevice, request: &SignedRelayRequest, expected_keys: &[&str]) {
        let mut body: BTreeMap<String, Value> = serde_json::from_slice(request.body()).unwrap();
        let signature = body.remove("signature").unwrap();
        let signature = signature.as_str().unwrap();
        let decoded = STANDARD.decode(signature).unwrap();
        assert_eq!(decoded.len(), 64);
        assert_eq!(STANDARD.encode(&decoded), signature);
        let keys = body.keys().map(String::as_str).collect::<Vec<_>>();
        assert_eq!(keys, expected_keys);
        let unsigned = serde_json::to_vec(&(
            request.operation(),
            own.scope().organisation().as_str(),
            own.scope().membership().as_str(),
            request.room().map(RelayId::as_str),
            &body,
        ))
        .unwrap();
        let mut transcript = b"kodera-e2ee-relay-v1\0".to_vec();
        transcript.extend_from_slice(&unsigned);
        OpenMlsRustCrypto::default()
            .crypto()
            .verify_signature(
                SUITE.signature_algorithm(),
                &transcript,
                &own.device_key(),
                &decoded,
            )
            .unwrap();
        assert!(std::str::from_utf8(request.body()).unwrap().is_ascii());
        assert_eq!(format!("{request:?}"), "SignedRelayRequest([redacted])");
        // Public synthetic protocol fixtures can be independently checked against
        // Python's actual signed_statement and Ed25519 verification. No private
        // key, checkpoint or plaintext message is printed.
        writeln!(std::io::stdout().lock(), "PUBLIC_RELAY_FIXTURE {}",serde_json::to_string(&json!({
            "publicKey":STANDARD.encode(own.device_key()),"operation":request.operation(),"organisation":own.scope().organisation().as_str(),"membership":own.scope().membership().as_str(),"room":request.room().map(RelayId::as_str),"body":serde_json::from_slice::<Value>(request.body()).unwrap(),
        })).unwrap()).unwrap();
    }

    #[test]
    fn signed_application_matches_the_independent_server_fixed_serialization_vector() {
        let org = OrganisationId::parse("01950000-0000-7000-8000-0000000000a1").unwrap();
        let member = RelayId::parse("01950000-0000-7000-8000-0000000000a2").unwrap();
        let target = RelayId::parse("01950000-0000-7000-8000-0000000000a4").unwrap();
        let scope = MlsDeviceScope::new(org.clone(), member);
        let mut store = TestStore::default();
        let mut own = finish(OpenMlsDevice::create_and_persist(
            scope,
            b"public protocol fixture",
            &[7; 32],
            &mut store,
        ))
        .unwrap();
        let key = own.device_key();
        finish(own.admit_and_persist(target, key, &[7; 32], &mut store)).unwrap();
        let room = NativeRoomScope::new(
            org,
            UuidV7::from_bytes_checked([
                1, 0x95, 0, 0, 0, 0, 0x70, 0, 0x80, 0, 0, 0, 0, 0, 0, 0xa3,
            ])
            .unwrap(),
        );
        let request = own
            .sign_relay_request(RelayStatement::SendApplication {
                room: &room,
                epoch: 7,
                ciphertext: &[255; 16],
            })
            .unwrap();
        let body: Value = serde_json::from_slice(request.body()).unwrap();
        assert_eq!(body["ciphertext"], "/////////////////////w==");
        let signature = STANDARD
            .decode(body["signature"].as_str().unwrap())
            .unwrap();
        let expected = concat!(
            "kodera-e2ee-relay-v1\0[\"send-application\",",
            "\"01950000-0000-7000-8000-0000000000a1\",",
            "\"01950000-0000-7000-8000-0000000000a2\",",
            "\"01950000-0000-7000-8000-0000000000a3\",",
            "{\"ciphertext\":\"/////////////////////w==\",",
            "\"deviceId\":\"01950000-0000-7000-8000-0000000000a4\",\"epoch\":7}]"
        );
        OpenMlsRustCrypto::default()
            .crypto()
            .verify_signature(
                SUITE.signature_algorithm(),
                expected.as_bytes(),
                &own.device_key(),
                &signature,
            )
            .unwrap();
    }

    #[test]
    fn every_closed_operation_has_exact_server_fields_and_verifiable_public_proofs() {
        let mut store = TestStore::default();
        let mut own = finish(OpenMlsDevice::create_and_persist(
            scope(),
            b"public protocol fixture",
            &[7; 32],
            &mut store,
        ))
        .unwrap();
        let registration = own.registration_request().unwrap();
        assert_eq!(registration.operation(), "register-device");
        assert!(registration.room().is_none());
        verify_public(&own, &registration, &["signingKey"]);
        let public = own.device_key();
        finish(own.admit_and_persist(admitted(10), public, &[7; 32], &mut store)).unwrap();
        let package = finish(own.prepare_key_package_and_persist(&[7; 32], &mut store)).unwrap();
        let room = room(1);
        let target = admitted(11);
        let channel = admitted(12);
        let roster = [admitted(11), admitted(10)]; // preserve explicitly supplied array order
        let backup_header = format!(
            "[\"kodera-zk-key-backup\",1,\"{}\",\"01950000-0000-7000-8000-0000000000b1\",1,\"recovery-key\",0,\"AAECAwQFBgcICQoLDA0ODw==\",\"EBESExQVFhcYGRob\"]",
            own.scope().organisation().as_str()
        );
        let mut backup_capsule = Vec::new();
        backup_capsule.extend_from_slice(b"KVKB1");
        backup_capsule.extend_from_slice(&(backup_header.len() as u32).to_be_bytes());
        backup_capsule.extend_from_slice(backup_header.as_bytes());
        backup_capsule.extend_from_slice(&[0xaa; 32]);
        let statements = [
            (
                RelayStatement::PublishKeyPackage {
                    package: package.id(),
                },
                "publish-key-package",
                vec!["deviceId", "keyPackage"],
                false,
            ),
            (
                RelayStatement::PublishKeyBackup {
                    backup_epoch: 1,
                    capsule: &backup_capsule,
                },
                "publish-key-backup",
                vec!["backupEpoch", "capsule", "deviceId"],
                false,
            ),
            (
                RelayStatement::CreateRoom {
                    channel: &channel,
                    algorithm: RelayAlgorithm::OpenMls,
                },
                "create-room",
                vec!["algorithm", "channelId", "deviceId"],
                false,
            ),
            (
                RelayStatement::ClaimKeyPackage {
                    room: &room,
                    target: &target,
                    epoch: 7,
                },
                "claim-key-package",
                vec!["deviceId", "epoch", "targetDeviceId"],
                true,
            ),
            (
                RelayStatement::SendApplication {
                    room: &room,
                    epoch: MAX_JSON_INTEGER,
                    ciphertext: &[255; 16],
                },
                "send-application",
                vec!["ciphertext", "deviceId", "epoch"],
                true,
            ),
            (
                RelayStatement::CommitEpoch {
                    room: &room,
                    epoch: 7,
                    devices: &roster,
                    ciphertext: &[255; 16],
                    welcome: Some(&[42; 16]),
                },
                "commit-epoch",
                vec!["ciphertext", "deviceId", "deviceIds", "epoch", "welcome"],
                true,
            ),
            (
                RelayStatement::RetireRoomDevice {
                    room: &room,
                    target: &target,
                    epoch: 7,
                },
                "retire-room-device",
                vec!["deviceId", "epoch", "targetDeviceId"],
                true,
            ),
            (
                RelayStatement::RevokeDevice { target: &target },
                "revoke-device",
                vec!["deviceId", "targetDeviceId"],
                false,
            ),
        ];
        for (statement, operation, keys, has_room) in statements {
            let request = own.sign_relay_request(statement).unwrap();
            assert_eq!(request.operation(), operation);
            assert_eq!(request.room().is_some(), has_room);
            let body: Value = serde_json::from_slice(request.body()).unwrap();
            assert_eq!(body["deviceId"], admitted(10).as_str());
            if operation == "publish-key-package" {
                assert_eq!(
                    STANDARD
                        .decode(body["keyPackage"].as_str().unwrap())
                        .unwrap(),
                    package.as_bytes()
                );
            }
            if operation == "commit-epoch" {
                assert_eq!(
                    body["deviceIds"],
                    json!([admitted(11).as_str(), admitted(10).as_str()])
                );
            }
            verify_public(&own, &request, &keys);
        }
        let request = own
            .sign_relay_request(RelayStatement::CommitEpoch {
                room: &room,
                epoch: 7,
                devices: &roster,
                ciphertext: &[255; 16],
                welcome: None,
            })
            .unwrap();
        verify_public(
            &own,
            &request,
            &["ciphertext", "deviceId", "deviceIds", "epoch"],
        );
        let megolm = own
            .sign_relay_request(RelayStatement::CreateRoom {
                channel: &channel,
                algorithm: RelayAlgorithm::Megolm,
            })
            .unwrap();
        assert_eq!(
            serde_json::from_slice::<Value>(megolm.body()).unwrap()["algorithm"],
            "m.megolm.v1.aes-sha2"
        );
    }

    #[test]
    fn claim_and_retirement_proofs_bind_the_requested_epoch() {
        let (own, _store) = fixture(10);
        let room = room(1);
        let target = admitted(11);
        let before = own.generation();
        for retirement in [false, true] {
            let statement = |value| {
                if retirement {
                    RelayStatement::RetireRoomDevice {
                        room: &room,
                        target: &target,
                        epoch: value,
                    }
                } else {
                    RelayStatement::ClaimKeyPackage {
                        room: &room,
                        target: &target,
                        epoch: value,
                    }
                }
            };
            let mut signatures = Vec::new();
            for value in [0, 7, MAX_JSON_INTEGER] {
                let request = own.sign_relay_request(statement(value)).unwrap();
                verify_public(&own, &request, &["deviceId", "epoch", "targetDeviceId"]);
                let body: Value = serde_json::from_slice(request.body()).unwrap();
                assert_eq!(body["epoch"], value);
                signatures.push(body["signature"].as_str().unwrap().to_owned());
            }
            assert_ne!(signatures[0], signatures[1]);
            assert_ne!(signatures[1], signatures[2]);
            assert!(matches!(
                own.sign_relay_request(statement(MAX_JSON_INTEGER + 1)),
                Err(NativeCryptoError::InvalidInput)
            ));
        }
        assert_eq!(own.generation(), before);
    }

    #[test]
    fn operation_specific_ciphertext_and_roster_boundaries_match_the_relay() {
        let (own, _store) = fixture(10);
        let room = room(1);
        let application = vec![42; 81_920];
        let application_overflow = vec![42; 81_921];
        let handshake = vec![43; 262_144];
        let handshake_overflow = vec![43; 262_145];
        let roster = (1..=128).map(admitted).collect::<Vec<_>>();
        let excessive_roster = (1..=129).map(admitted).collect::<Vec<_>>();
        let before = own.generation();

        let request = own
            .sign_relay_request(RelayStatement::SendApplication {
                room: &room,
                epoch: 1,
                ciphertext: &application,
            })
            .unwrap();
        let body: Value = serde_json::from_slice(request.body()).unwrap();
        assert_eq!(
            STANDARD
                .decode(body["ciphertext"].as_str().unwrap())
                .unwrap(),
            application
        );
        assert!(matches!(
            own.sign_relay_request(RelayStatement::SendApplication {
                room: &room,
                epoch: 1,
                ciphertext: &application_overflow,
            }),
            Err(NativeCryptoError::InvalidInput)
        ));

        // Both handshake fields retain their independent 256KiB bounds, with
        // the maximum valid roster and complete signed HTTP body admitted.
        let request = own
            .sign_relay_request(RelayStatement::CommitEpoch {
                room: &room,
                epoch: 1,
                devices: &roster,
                ciphertext: &handshake,
                welcome: Some(&handshake),
            })
            .unwrap();
        let body: Value = serde_json::from_slice(request.body()).unwrap();
        assert_eq!(body["deviceIds"].as_array().unwrap().len(), 128);
        for field in ["ciphertext", "welcome"] {
            assert_eq!(
                STANDARD.decode(body[field].as_str().unwrap()).unwrap(),
                handshake
            );
        }
        for statement in [
            RelayStatement::CommitEpoch {
                room: &room,
                epoch: 1,
                devices: &roster,
                ciphertext: &handshake_overflow,
                welcome: Some(&[0; 16]),
            },
            RelayStatement::CommitEpoch {
                room: &room,
                epoch: 1,
                devices: &roster,
                ciphertext: &[0; 16],
                welcome: Some(&handshake_overflow),
            },
            RelayStatement::CommitEpoch {
                room: &room,
                epoch: 1,
                devices: &[],
                ciphertext: &[0; 16],
                welcome: None,
            },
            RelayStatement::CommitEpoch {
                room: &room,
                epoch: 1,
                devices: &excessive_roster,
                ciphertext: &[0; 16],
                welcome: None,
            },
        ] {
            assert!(matches!(
                own.sign_relay_request(statement),
                Err(NativeCryptoError::InvalidInput)
            ));
        }
        assert_eq!(own.generation(), before);
    }

    #[test]
    fn typed_bounds_scope_and_admission_refuse_before_signing_without_state_change() {
        let (own, _store) = fixture(10);
        let room = room(1);
        let target = admitted(11);
        let too_large = vec![0; MAX_APPLICATION_CIPHERTEXT + 1];
        let duplicate = [admitted(10), admitted(10)];
        let missing_self = [admitted(11)];
        let too_many = (1..=129).map(admitted).collect::<Vec<_>>();
        let before = own.generation();
        for statement in [
            RelayStatement::RegisterDevice,
            RelayStatement::SendApplication {
                room: &room,
                epoch: MAX_JSON_INTEGER + 1,
                ciphertext: &[0; 16],
            },
            RelayStatement::SendApplication {
                room: &room,
                epoch: 1,
                ciphertext: &[0; 15],
            },
            RelayStatement::SendApplication {
                room: &room,
                epoch: 1,
                ciphertext: &too_large,
            },
            RelayStatement::CommitEpoch {
                room: &room,
                epoch: 1,
                devices: &duplicate,
                ciphertext: &[0; 16],
                welcome: None,
            },
            RelayStatement::CommitEpoch {
                room: &room,
                epoch: 1,
                devices: &missing_self,
                ciphertext: &[0; 16],
                welcome: None,
            },
            RelayStatement::CommitEpoch {
                room: &room,
                epoch: 1,
                devices: &too_many,
                ciphertext: &[0; 16],
                welcome: None,
            },
            RelayStatement::PublishKeyPackage {
                package: PendingMlsPackageId::from_bytes([0; 32]),
            },
        ] {
            assert!(own.sign_relay_request(statement).is_err());
        }
        let foreign = NativeRoomScope::new(
            OrganisationId::parse("00000000-0000-4000-8000-000000000099").unwrap(),
            room.room(),
        );
        assert!(matches!(
            own.sign_relay_request(RelayStatement::ClaimKeyPackage {
                room: &foreign,
                target: &target,
                epoch: 0,
            }),
            Err(NativeCryptoError::ScopeMismatch)
        ));
        assert_eq!(own.generation(), before);
        for id in [
            "00000000-0000-0000-0000-000000000000",
            "01950000-0000-7000-8000-0000000000A1",
            " 01950000-0000-7000-8000-0000000000a1",
            "019500000000700080000000000000a1",
        ] {
            assert!(RelayId::parse(id).is_err());
        }
        let mut store = TestStore::default();
        let unadmitted = finish(OpenMlsDevice::create_and_persist(
            scope(),
            b"public protocol fixture",
            &[7; 32],
            &mut store,
        ))
        .unwrap();
        assert!(matches!(
            unadmitted.sign_relay_request(RelayStatement::RevokeDevice { target: &target }),
            Err(NativeCryptoError::UnauthorisedDevice)
        ));
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum RelayAlgorithm {
    OpenMls,
    Megolm,
}

/// Every variant has exactly the fields admitted by the server. Identifiers for
/// the organisation, membership and signing device always come from the device.
pub enum RelayStatement<'a> {
    RegisterDevice,
    PublishKeyPackage {
        package: PendingMlsPackageId,
    },
    PublishKeyBackup {
        backup_epoch: u64,
        capsule: &'a [u8],
    },
    CreateRoom {
        channel: &'a RelayId,
        algorithm: RelayAlgorithm,
    },
    ClaimKeyPackage {
        room: &'a NativeRoomScope,
        target: &'a RelayId,
        epoch: u64,
    },
    SendApplication {
        room: &'a NativeRoomScope,
        epoch: u64,
        ciphertext: &'a [u8],
    },
    CommitEpoch {
        room: &'a NativeRoomScope,
        epoch: u64,
        devices: &'a [RelayId],
        ciphertext: &'a [u8],
        welcome: Option<&'a [u8]>,
    },
    RetireRoomDevice {
        room: &'a NativeRoomScope,
        target: &'a RelayId,
        epoch: u64,
    },
    RevokeDevice {
        target: &'a RelayId,
    },
}

/// Public HTTP data only; Debug is redacted to discourage logging whole requests.
pub struct SignedRelayRequest {
    operation: &'static str,
    room: Option<RelayId>,
    body: Vec<u8>,
}

impl fmt::Debug for SignedRelayRequest {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str("SignedRelayRequest([redacted])")
    }
}

impl SignedRelayRequest {
    pub fn operation(&self) -> &'static str {
        self.operation
    }
    pub fn room(&self) -> Option<&RelayId> {
        self.room.as_ref()
    }
    pub fn body(&self) -> &[u8] {
        &self.body
    }
}

fn ciphertext(bytes: &[u8], maximum: usize) -> Result<Value, NativeCryptoError> {
    if !(16..=maximum).contains(&bytes.len()) {
        return Err(NativeCryptoError::InvalidInput);
    }
    Ok(Value::String(STANDARD.encode(bytes)))
}

fn epoch(value: u64) -> Result<Value, NativeCryptoError> {
    if value > MAX_JSON_INTEGER {
        return Err(NativeCryptoError::InvalidInput);
    }
    Ok(json!(value))
}

impl OpenMlsDevice {
    /// Sign only the exact closed relay protocol. This neither authenticates a
    /// host-supplied admission response nor bypasses the server's current ACLs.
    pub fn sign_relay_request(
        &self,
        statement: RelayStatement<'_>,
    ) -> Result<SignedRelayRequest, NativeCryptoError> {
        self.ensure_live()?;
        let mut body = BTreeMap::<&str, Value>::new();
        let mut resource = None;
        let operation = if matches!(&statement, RelayStatement::RegisterDevice) {
            if self.admitted_id().is_some() {
                return Err(NativeCryptoError::InvalidInput);
            }
            body.insert("signingKey", json!(STANDARD.encode(self.device_key())));
            "register-device"
        } else {
            let own = self
                .admitted_id()
                .ok_or(NativeCryptoError::UnauthorisedDevice)?;
            body.insert("deviceId", json!(own.as_str()));
            match statement {
                RelayStatement::RegisterDevice => unreachable!("registration handled separately"),
                RelayStatement::PublishKeyPackage { package } => {
                    body.insert(
                        "keyPackage",
                        json!(STANDARD.encode(self.pending_wire(package)?)),
                    );
                    "publish-key-package"
                }
                RelayStatement::PublishKeyBackup {
                    backup_epoch,
                    capsule,
                } => {
                    if !(1..=MAX_JSON_INTEGER).contains(&backup_epoch) {
                        return Err(NativeCryptoError::InvalidInput);
                    }
                    let parsed = crate::key_backup::parse_kvkb1_capsule(
                        capsule,
                        crate::key_backup::MAX_RELAY_KEY_BACKUP_CAPSULE_BYTES,
                    )
                    .map_err(|_| NativeCryptoError::InvalidInput)?;
                    RelayId::parse(&parsed.account_id)?;
                    if parsed.organisation_id != self.scope().organisation().as_str() {
                        return Err(NativeCryptoError::ScopeMismatch);
                    }
                    if parsed.backup_epoch != backup_epoch {
                        return Err(NativeCryptoError::InvalidInput);
                    }
                    body.insert("backupEpoch", epoch(backup_epoch)?);
                    body.insert("capsule", json!(STANDARD.encode(capsule)));
                    "publish-key-backup"
                }
                RelayStatement::CreateRoom { channel, algorithm } => {
                    body.insert("channelId", json!(channel.as_str()));
                    body.insert(
                        "algorithm",
                        json!(match algorithm {
                            RelayAlgorithm::OpenMls => "io.kodera.mls.v1",
                            RelayAlgorithm::Megolm => "m.megolm.v1.aes-sha2",
                        }),
                    );
                    "create-room"
                }
                RelayStatement::ClaimKeyPackage {
                    room,
                    target,
                    epoch: value,
                } => {
                    resource = Some(self.relay_room(room)?);
                    body.insert("targetDeviceId", json!(target.as_str()));
                    body.insert("epoch", epoch(value)?);
                    "claim-key-package"
                }
                RelayStatement::SendApplication {
                    room,
                    epoch: value,
                    ciphertext: bytes,
                } => {
                    resource = Some(self.relay_room(room)?);
                    body.insert("epoch", epoch(value)?);
                    body.insert("ciphertext", ciphertext(bytes, MAX_APPLICATION_CIPHERTEXT)?);
                    "send-application"
                }
                RelayStatement::CommitEpoch {
                    room,
                    epoch: value,
                    devices,
                    ciphertext: bytes,
                    welcome,
                } => {
                    resource = Some(self.relay_room(room)?);
                    if devices.is_empty() || devices.len() > MAX_MEMBERS {
                        return Err(NativeCryptoError::InvalidInput);
                    }
                    let unique: HashSet<_> = devices.iter().collect();
                    if unique.len() != devices.len() || !devices.contains(own) {
                        return Err(NativeCryptoError::InvalidInput);
                    }
                    body.insert("epoch", epoch(value)?);
                    body.insert(
                        "deviceIds",
                        json!(devices.iter().map(RelayId::as_str).collect::<Vec<_>>()),
                    );
                    body.insert("ciphertext", ciphertext(bytes, MAX_HANDSHAKE_CIPHERTEXT)?);
                    if let Some(bytes) = welcome {
                        body.insert("welcome", ciphertext(bytes, MAX_HANDSHAKE_CIPHERTEXT)?);
                    }
                    "commit-epoch"
                }
                RelayStatement::RetireRoomDevice {
                    room,
                    target,
                    epoch: value,
                } => {
                    resource = Some(self.relay_room(room)?);
                    body.insert("targetDeviceId", json!(target.as_str()));
                    body.insert("epoch", epoch(value)?);
                    "retire-room-device"
                }
                RelayStatement::RevokeDevice { target } => {
                    body.insert("targetDeviceId", json!(target.as_str()));
                    "revoke-device"
                }
            }
        };
        // All admitted strings are canonical UUIDs, fixed ASCII protocol names
        // or standard padded base64. Thus Python ensure_ascii=True and this
        // serializer have identical string escaping. BTreeMap sorts object keys;
        // the roster array retains its explicitly supplied order.
        let transcript = serde_json::to_vec(&(
            operation,
            self.scope().organisation().as_str(),
            self.scope().membership().as_str(),
            resource.as_ref().map(RelayId::as_str),
            &body,
        ))
        .map_err(failed)?;
        let mut statement = b"kodera-e2ee-relay-v1\0".to_vec();
        statement.extend_from_slice(&transcript);
        let signature = self.sign_relay_statement(&statement)?;
        body.insert("signature", json!(STANDARD.encode(signature)));
        let body = serde_json::to_vec(&body).map_err(failed)?;
        if body.len() > MAX_HTTP_BODY {
            return Err(NativeCryptoError::Capacity);
        }
        Ok(SignedRelayRequest {
            operation,
            room: resource,
            body,
        })
    }

    fn relay_room(&self, room: &NativeRoomScope) -> Result<RelayId, NativeCryptoError> {
        if room.organisation() != self.scope().organisation() {
            return Err(NativeCryptoError::ScopeMismatch);
        }
        RelayId::parse(&room.room().to_string())
    }
}
