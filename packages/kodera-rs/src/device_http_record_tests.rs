//! Public structural vectors, not native signatures, HPKE state or HTTP authority.
use super::*;
use serde_json::Value;

fn vectors() -> Value {
    serde_json::from_str(include_str!("../vectors/device-http-v1.json")).unwrap()
}
fn unhex(value: &str) -> Vec<u8> {
    value
        .as_bytes()
        .chunks_exact(2)
        .map(|pair| u8::from_str_radix(std::str::from_utf8(pair).unwrap(), 16).unwrap())
        .collect()
}
fn frame(json: &str) -> Vec<u8> {
    let mut bytes = b"KDH1".to_vec();
    bytes.extend_from_slice(&(json.len() as u32).to_be_bytes());
    bytes.extend_from_slice(json.as_bytes());
    bytes
}
fn sample(index: usize) -> DeviceHttpRecord {
    DeviceHttpRecord::decode(&unhex(
        vectors()["records"][index]["frameHex"].as_str().unwrap(),
    ))
    .unwrap()
}

#[test]
fn public_records_have_exact_canonical_bytes_and_independent_hashes() {
    for row in vectors()["records"].as_array().unwrap() {
        let raw = unhex(row["frameHex"].as_str().unwrap());
        let record = DeviceHttpRecord::decode(&raw).unwrap();
        assert_eq!(record.encode().unwrap(), raw);
        assert_eq!(&raw[8..], row["canonicalJson"].as_str().unwrap().as_bytes());
        assert_eq!(
            crate::sha256(&raw).to_vec(),
            unhex(row["frameSha256"].as_str().unwrap())
        );
    }
}

#[test]
fn framing_utf8_duplicate_unknown_order_and_noncanonical_numbers_refuse() {
    let original = vectors()["records"][0]["canonicalJson"]
        .as_str()
        .unwrap()
        .to_owned();
    for json in [
        original.replacen("{", "{\"version\":1,", 1),
        original.replacen("{", "{\"unknown\":1,", 1),
        original.replacen("\"version\":1", "\"version\":1.0", 1),
        original.replacen(
            "\"version\":1,\"recordId\"",
            "\"version\":1, \"recordId\"",
            1,
        ),
        original
            .replacen("\"version\":1,", "", 1)
            .replacen("}", ",\"version\":1}", 1),
    ] {
        assert!(DeviceHttpRecord::decode(&frame(&json)).is_err());
    }
    let raw = sample(0).encode().unwrap();
    for length in 0..8 {
        assert!(DeviceHttpRecord::decode(&raw[..length]).is_err());
    }
    let mut bad = raw.clone();
    bad.push(0);
    assert!(DeviceHttpRecord::decode(&bad).is_err());
    let mut bad = raw.clone();
    bad[7] ^= 1;
    assert!(DeviceHttpRecord::decode(&bad).is_err());
    let mut bad = raw;
    bad[8] = 0xff;
    assert!(DeviceHttpRecord::decode(&bad).is_err());
    assert!(DeviceHttpRecord::decode(&vec![0; MAX_DEVICE_HTTP_RECORD_BYTES + 1]).is_err());
}

#[test]
fn strict_union_recovery_clocks_identifiers_and_body_digest() {
    let base = sample(1);
    let mut bad = base.clone();
    bad.native_generation = 0;
    assert!(bad.encode().is_err());
    let mut bad = base.clone();
    bad.scope[0] = "00000000-0000-0000-0000-000000000000".into();
    assert!(bad.encode().is_err());
    let mut bad = base.clone();
    bad.record_id.push('\n');
    assert!(bad.encode().is_err());
    let mut bad = base.clone();
    bad.sealed_sha256 = "AA".repeat(32);
    assert!(bad.encode().is_err());
    let mut bad = base.clone();
    bad.pending.as_mut().unwrap().recovery_spent = 1;
    assert!(bad.encode().is_err());
    let mut bad = base.clone();
    bad.pending.as_mut().unwrap().body_sha256 = "00".repeat(32);
    assert!(bad.encode().is_err());
    let mut bad = base.clone();
    bad.pending.as_mut().unwrap().native_package_id = Some("33".repeat(32));
    assert!(bad.encode().is_err());
    let mut bad = base.clone();
    bad.admission = sample(3).admission;
    assert!(bad.encode().is_err());
    let mut bad = sample(4);
    bad.admission = None;
    assert!(bad.encode().is_err());
    let mut bad = sample(5);
    bad.publication = sample(6).publication;
    assert!(bad.encode().is_err());
    let mut bad = sample(2);
    bad.pending.as_mut().unwrap().recovery_spent = 2;
    assert!(bad.encode().is_err());
    let mut bad = sample(2);
    bad.pending.as_mut().unwrap().retry_before_ms = Some(MAX_SAFE_INTEGER);
    assert!(bad.encode().is_err());
    let mut bad = sample(2);
    bad.pending.as_mut().unwrap().first_attempt_at_ms = Some(MAX_SAFE_INTEGER);
    assert!(bad.encode().is_err());
    let text = String::from_utf8(base.encode().unwrap()[8..].to_vec()).unwrap();
    assert!(DeviceHttpRecord::decode(&frame(&text.replace("\"recoverySpent\":0,", ""))).is_err());
    for invalid in ["", "e30", "e31=", "e30=\n", "e30= ", "____"] {
        let mut bad = base.clone();
        bad.pending.as_mut().unwrap().body_base64 = invalid.into();
        bad.pending.as_mut().unwrap().body_sha256 = hex(&crate::sha256(b"{}"));
        assert!(bad.encode().is_err());
    }
    let mut healthy = base.clone();
    healthy.pending.as_mut().unwrap().body_base64 = "e30=".into();
    healthy.pending.as_mut().unwrap().body_sha256 = hex(&crate::sha256(b"{}"));
    assert!(healthy.encode().is_ok());
    for (before, after) in [
        (
            "\"phase\":\"prepared\"",
            "\"phase\":\"prepared\",\"phase\":\"prepared\"",
        ),
        ("\"recoverySpent\":0", "\"extra\":0,\"recoverySpent\":0"),
        ("\"firstAttemptAtMs\":null", "\"firstAttemptAtMs\":0"),
        ("\"packageWireSha256\":null", "\"packageWireSha256\":\"\""),
    ] {
        assert!(DeviceHttpRecord::decode(&frame(&text.replace(before, after))).is_err());
    }
    let mut good = sample(2);
    let p = good.pending.as_mut().unwrap();
    p.first_attempt_at_ms = Some(MAX_SAFE_INTEGER - RETRY_HORIZON_MS);
    p.retry_before_ms = Some(MAX_SAFE_INTEGER);
    assert!(good.encode().is_ok());
}

#[test]
fn body_boundaries_and_expiry_calendar_are_real_validation() {
    for size in [1, MAX_DEVICE_HTTP_BODY_BYTES] {
        let mut record = sample(1);
        let body = vec![b'x'; size];
        let pending = record.pending.as_mut().unwrap();
        pending.body_base64 = STANDARD.encode(&body);
        pending.body_sha256 = hex(&crate::sha256(&body));
        assert!(record.encode().is_ok());
    }
    let mut bad = sample(1);
    let body = vec![b'x'; MAX_DEVICE_HTTP_BODY_BYTES + 1];
    bad.pending.as_mut().unwrap().body_base64 = STANDARD.encode(&body);
    bad.pending.as_mut().unwrap().body_sha256 = hex(&crate::sha256(&body));
    assert!(bad.encode().is_err());
    for expiry in [
        "2025-02-29T00:00:00Z",
        "2026-11-23",
        "2026-11-23T24:00:00Z",
        "2026-11-23T00:00:00+24:00",
        "2026-11-23T00:00:00Z\n",
    ] {
        let mut bad = sample(6);
        bad.publication.as_mut().unwrap().expires_at = expiry.into();
        assert!(bad.encode().is_err());
    }
    let mut good = sample(6);
    good.publication.as_mut().unwrap().expires_at = "2024-02-29T12:59:59.123Z".into();
    assert!(good.encode().is_ok());
    good.publication.as_mut().unwrap().expires_at = "2016-12-31T23:59:60Z".into();
    assert!(good.encode().is_ok());
    // Deliberately different domains: parsing must not require equal IDs.
    let p = good.publication.as_ref().unwrap();
    assert_ne!(p.native_package_id, p.package_wire_sha256);
}

#[test]
fn separate_native_and_host_binding_never_substitutes_g_for_n() {
    let record = sample(5);
    assert!(record
        .validate_binding(&record.scope, 3, 7, &record.sealed_sha256)
        .is_ok());
    assert!(record
        .validate_binding(&record.scope, 7, 7, &record.sealed_sha256)
        .is_err());
    assert!(record
        .validate_binding(&record.scope, 3, 2, &record.sealed_sha256)
        .is_err());
    assert!(record
        .validate_binding(&record.scope, 3, 7, &"00".repeat(32))
        .is_err());
    let mut scope = record.scope.clone();
    scope.swap(0, 1);
    assert!(record
        .validate_binding(&scope, 3, 7, &record.sealed_sha256)
        .is_err());
}

#[test]
fn acknowledgement_all_276_bytes_and_safe_clock_boundaries_bind() {
    for row in vectors()["acknowledgements"].as_array().unwrap() {
        let raw = unhex(row["frameHex"].as_str().unwrap());
        assert_eq!(raw.len(), DEVICE_HTTP_ACK_BYTES);
        let ack = DeviceHttpAck::decode(&raw).unwrap();
        assert_eq!(ack.encode().unwrap().as_slice(), raw);
        DeviceHttpAck::verify(&raw, &ack).unwrap();
        for at in 0..raw.len() {
            let mut wrong = raw.clone();
            wrong[at] ^= 1;
            assert!(DeviceHttpAck::verify(&wrong, &ack).is_err());
        }
        let mut tail = raw.clone();
        tail.push(0);
        assert!(DeviceHttpAck::decode(&tail).is_err());
        assert!(DeviceHttpAck::decode(&raw[..275]).is_err());
    }
    let mut ack = DeviceHttpAck::decode(&unhex(
        vectors()["acknowledgements"][0]["frameHex"]
            .as_str()
            .unwrap(),
    ))
    .unwrap();
    ack.next_host_generation = ack.expected_host_generation;
    assert!(ack.encode().is_err());
    ack.next_host_generation += 1;
    ack.next_native_generation += 2;
    assert!(ack.encode().is_err());
    ack.next_native_generation = ack.expected_native_generation;
    ack.expected_host_generation = MAX_SAFE_INTEGER;
    ack.next_host_generation = MAX_SAFE_INTEGER + 1;
    assert!(ack.encode().is_err());
}
