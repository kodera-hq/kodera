//! Holds this crate's frame codec to `vectors/proximity-frame-v1.txt`, the file the Swift and
//! Kotlin codecs read too. The v1 wire format is frozen: these tests fail when a byte moves.

use crate::{
    decode_hex, encode_hex, CoreError, ProximityFrame, SafetyStatus, MAX_PROXIMITY_FRAME_BYTES,
    MAX_PROXIMITY_TEXT_BYTES, MAX_PROXIMITY_TTL_HOPS,
};
use std::collections::BTreeMap;

const VECTORS: &str = include_str!("../vectors/proximity-frame-v1.txt");

struct FrameVector {
    name: String,
    ttl_hops: u8,
    status: u8,
    timestamp_ms: u64,
    text: Vec<u8>,
    wire: Vec<u8>,
    transcript: Vec<u8>,
}

struct FrameVectors {
    constants: BTreeMap<String, String>,
    frames: Vec<FrameVector>,
    refused: Vec<(String, Vec<u8>)>,
}

fn hex(field: &str, line: usize) -> Vec<u8> {
    decode_hex(field).unwrap_or_else(|_| panic!("vectors line {line}: {field:?} is not hex"))
}

fn number<T: std::str::FromStr>(field: &str, line: usize) -> T {
    field
        .parse()
        .unwrap_or_else(|_| panic!("vectors line {line}: {field:?} is not a number"))
}

/// Strict: a line outside the grammar fails the test rather than being skipped.
fn vectors() -> FrameVectors {
    let mut parsed = FrameVectors {
        constants: BTreeMap::new(),
        frames: Vec::new(),
        refused: Vec::new(),
    };
    for (index, line) in VECTORS.lines().enumerate() {
        let n = index + 1;
        if line.is_empty() || line.starts_with('#') {
            continue;
        }
        match line.split(' ').collect::<Vec<_>>().as_slice() {
            ["const", name, value] => {
                let previous = parsed
                    .constants
                    .insert((*name).to_owned(), (*value).to_owned());
                assert!(previous.is_none(), "vectors line {n}: {name} stated twice");
            }
            ["frame", name, ttl, status, timestamp, text, wire, transcript] => {
                parsed.frames.push(FrameVector {
                    name: (*name).to_owned(),
                    ttl_hops: number(ttl, n),
                    status: number(status, n),
                    timestamp_ms: number(timestamp, n),
                    text: if *text == "-" {
                        Vec::new()
                    } else {
                        hex(text, n)
                    },
                    wire: hex(wire, n),
                    transcript: hex(transcript, n),
                })
            }
            ["refuse", name, wire] => parsed.refused.push(((*name).to_owned(), hex(wire, n))),
            _ => panic!("vectors line {n} is not in the grammar: {line:?}"),
        }
    }
    parsed
}

/// True when `wire` is, for this codec, exactly the frame the vector states: it decodes to the
/// stated fields, encodes back to the vector's own bytes and signs the vector's own transcript.
fn conforms(vector: &FrameVector, wire: &[u8]) -> bool {
    let Ok(frame) = ProximityFrame::decode(wire) else {
        return false;
    };
    let transcript = ProximityFrame::signing_transcript(
        &frame.message_id,
        &frame.sender_public_key,
        frame.status,
        frame.text.as_bytes(),
    );
    frame.ttl_hops == vector.ttl_hops
        && frame.status as u8 == vector.status
        && frame.message_id.timestamp_ms() == vector.timestamp_ms
        && frame.text.as_bytes() == vector.text
        && frame.encode().as_deref() == Ok(vector.wire.as_slice())
        && transcript == vector.transcript
}

#[test]
fn shared_vectors_state_the_frozen_constants_this_crate_encodes() {
    let shared = vectors();
    let constant = |name: &str| shared.constants[name].as_str();
    assert_eq!(shared.constants.len(), 7);
    assert_eq!(constant("magic_hex"), encode_hex(&ProximityFrame::MAGIC));
    assert_eq!(constant("magic_hex"), "4b45");
    assert_eq!(constant("version"), ProximityFrame::VERSION.to_string());
    assert_eq!(
        constant("fixed_overhead_bytes"),
        ProximityFrame::FIXED_OVERHEAD.to_string()
    );
    assert_eq!(
        constant("max_frame_bytes"),
        MAX_PROXIMITY_FRAME_BYTES.to_string()
    );
    assert_eq!(
        constant("max_text_bytes"),
        MAX_PROXIMITY_TEXT_BYTES.to_string()
    );
    assert_eq!(constant("max_ttl_hops"), MAX_PROXIMITY_TTL_HOPS.to_string());
    // The signed label keeps the channel's first name: it is wire, not vocabulary.
    assert_eq!(
        hex(constant("signing_label_hex"), 0),
        b"kodera-emergency-v1:"
    );
}

#[test]
fn every_shared_frame_decodes_encodes_and_signs_byte_for_byte() {
    let shared = vectors();
    assert!(shared.frames.len() >= 5);
    assert_eq!(shared.frames[0].name, "canonical");
    assert_eq!(shared.frames[0].wire.len(), 129);
    let label = hex(&shared.constants["signing_label_hex"], 0);
    let mut statuses = std::collections::BTreeSet::new();
    let mut sizes = std::collections::BTreeSet::new();
    for vector in &shared.frames {
        assert!(conforms(vector, &vector.wire), "{}", vector.name);
        // The transcript is the label, then bytes 3..51, then bytes 52 up to the signature.
        let signed_end = vector.wire.len() - 64;
        let expected = [
            &label[..],
            &vector.wire[3..51],
            &vector.wire[52..signed_end],
        ]
        .concat();
        assert_eq!(vector.transcript, expected, "{}", vector.name);
        let frame = ProximityFrame::decode(&vector.wire).unwrap();
        assert_eq!(frame.signature[..], vector.wire[signed_end..]);
        assert_eq!(frame.sender_public_key[..], vector.wire[19..51]);
        statuses.insert(vector.status);
        sizes.insert(vector.wire.len());
    }
    assert_eq!(statuses.into_iter().collect::<Vec<_>>(), vec![0, 1, 2, 3]);
    assert!(sizes.contains(&118) && sizes.contains(&MAX_PROXIMITY_FRAME_BYTES));
    assert_eq!(SafetyStatus::MusterPoint as u8, 3);
}

#[test]
fn every_shared_refused_frame_fails_to_decode() {
    let shared = vectors();
    assert!(shared.refused.len() >= 15);
    for (name, wire) in &shared.refused {
        assert!(
            matches!(
                ProximityFrame::decode(wire),
                Err(CoreError::MalformedFrame
                    | CoreError::InvalidTtl
                    | CoreError::InvalidStatusBadge
                    | CoreError::InvalidUuidV7)
            ),
            "{name}"
        );
    }
}

/// Refusal mutation: flip one bit of a shared frame at every offset. The vector check must fail
/// each time, so no byte of the frozen layout is outside what the vectors pin.
#[test]
fn flipping_any_single_byte_of_a_shared_frame_breaks_conformance() {
    for vector in &vectors().frames {
        for offset in 0..vector.wire.len() {
            let mut mutated = vector.wire.clone();
            mutated[offset] ^= 0x01;
            assert!(
                !conforms(vector, &mutated),
                "{}: byte {offset} is not pinned",
                vector.name
            );
        }
        // Truncation and extension are refused too, at both ends.
        assert!(!conforms(vector, &vector.wire[1..]));
        assert!(!conforms(vector, &vector.wire[..vector.wire.len() - 1]));
        assert!(!conforms(vector, &[&vector.wire[..], &[0u8]].concat()));
    }
}
