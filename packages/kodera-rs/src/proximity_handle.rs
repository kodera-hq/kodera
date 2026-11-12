//! Pseudonymous sender labels for `#proximity` check-ins.
//!
//! A proximity frame carries its sender's device public key and nothing else about the person.
//! What a client shows next to a check-in is a [`ProximityHandle`]: a pseudonym the member picked
//! for this purpose ([`ProximityHandleOrigin::Dedicated`]) or one derived for the sender inside
//! one organisation ([`ProximityHandleOrigin::Generated`]). A real name is never required and
//! never travels in a frame. The frozen v1 wire format is untouched: a handle is display metadata
//! held beside the frame, never inside it.
//!
//! # A handle is a display label, never an identity
//!
//! A handle is never an identity and never an authorisation input. Identity stays the Ed25519
//! signing key: the roster and the signature decide what is admitted, and no code may grant,
//! refuse, deduplicate or look up anything by handle. A dedicated handle is whatever its member
//! typed, within the grammar. A generated handle keeps 55 bits of a keyed digest: enough that two
//! members of one roster do not meet by accident, not enough to stop someone who can try keys
//! until one matches. A key reaches a roster only through provisioning, and a matching handle
//! gives its holder nothing but a label; still, a client that lists a roster must run
//! [`disambiguate_proximity_handles`], which shows equal handles with a fingerprint of each
//! signing key.
//!
//! The derivation is keyed with the organisation's beacon salt, so the same key shows another
//! handle in another organisation: handles are not linkable across organisations, and one
//! searched for in one organisation is worth nothing elsewhere.
//!
//! `vectors/proximity-handle-v1.txt` states the grammar, the word lists and the vectors for the
//! Swift and Kotlin ports.

use crate::{encode_hex, hmac_sha256, sha256, CoreError, Ed25519PublicKey};

/// Fewest characters in a handle.
pub const MIN_PROXIMITY_HANDLE_CHARS: usize = 3;
/// Most characters in a handle. The grammar is ASCII, so characters and bytes agree.
pub const MAX_PROXIMITY_HANDLE_CHARS: usize = 24;
/// Characters after the two words of a generated handle: 45 bits, five per character. With the
/// longest adjective and noun this fills the 24-character bound exactly.
pub const PROXIMITY_HANDLE_SUFFIX_CHARS: usize = 9;
/// Digest bits a generated handle keeps: five per word and 45 in the suffix.
pub const PROXIMITY_HANDLE_DIGEST_BITS: usize = 55;
/// Shortest fingerprint prefix shown beside a handle that is not unique in its roster.
pub const MIN_PROXIMITY_FINGERPRINT_HEX_CHARS: usize = 8;

/// MACed with the sender key under the organisation's beacon salt to derive a generated handle.
/// It labels a display value only: it is not part of the frozen frame v1 and signs nothing.
const GENERATED_HANDLE_LABEL: &[u8] = b"kodera-proximity-handle-v1:";
/// Hashed with the sender key for the fingerprint that tells equal handles apart.
const FINGERPRINT_LABEL: &[u8] = b"kodera-proximity-fingerprint-v1:";
/// Lowercase, digits first, without `i`, `l`, `o` and `u`: five bits per character.
const SUFFIX_ALPHABET: &[u8; 32] = b"0123456789abcdefghjkmnpqrstvwxyz";

const ADJECTIVES: [&str; 32] = [
    "amber", "brisk", "calm", "clear", "coral", "crisp", "dusky", "early", "fair", "gentle",
    "golden", "green", "hazel", "ivory", "jade", "keen", "light", "lunar", "mellow", "misty",
    "noble", "olive", "pale", "quiet", "rapid", "royal", "sandy", "silver", "solar", "steady",
    "swift", "vivid",
];

const NOUNS: [&str; 32] = [
    "alder", "aspen", "badger", "birch", "brook", "cedar", "comet", "crane", "delta", "dune",
    "ember", "falcon", "fern", "finch", "glade", "harbor", "heron", "island", "juniper", "lark",
    "lynx", "maple", "meadow", "otter", "pebble", "pine", "quartz", "raven", "reef", "river",
    "sparrow", "willow",
];

/// Where a handle comes from.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub enum ProximityHandleOrigin {
    /// Picked by the member as their proximity pseudonym.
    Dedicated,
    /// Derived from the sender key when the member picked none.
    Generated,
}

impl ProximityHandleOrigin {
    pub fn parse(slug: &str) -> Result<Self, CoreError> {
        match slug {
            "dedicated" => Ok(Self::Dedicated),
            "generated" => Ok(Self::Generated),
            _ => Err(CoreError::InvalidProximityHandle),
        }
    }

    pub fn as_slug(&self) -> &'static str {
        match self {
            Self::Dedicated => "dedicated",
            Self::Generated => "generated",
        }
    }
}

/// Accepts exactly `^[a-z0-9]+(?:-[a-z0-9]+)*$` with 3 to 24 characters: lowercase ASCII letters
/// and digits in groups joined by single hyphens. Nothing is trimmed, folded or normalised, so a
/// display name, an email address or any non-ASCII text is refused rather than repaired.
pub fn validate_proximity_handle(raw: &str) -> Result<(), CoreError> {
    let bytes = raw.as_bytes();
    if !(MIN_PROXIMITY_HANDLE_CHARS..=MAX_PROXIMITY_HANDLE_CHARS).contains(&bytes.len()) {
        return Err(CoreError::InvalidProximityHandle);
    }
    let mut previous_was_hyphen = true; // a leading hyphen is refused like a doubled one
    for &byte in bytes {
        let is_hyphen = byte == b'-';
        let is_word = byte.is_ascii_lowercase() || byte.is_ascii_digit();
        if !(is_word || is_hyphen) || (is_hyphen && previous_was_hyphen) {
            return Err(CoreError::InvalidProximityHandle);
        }
        previous_was_hyphen = is_hyphen;
    }
    if previous_was_hyphen {
        return Err(CoreError::InvalidProximityHandle);
    }
    Ok(())
}

/// The label shown for the sender of a check-in. Constructed only through validation or
/// generation, so a held value always satisfies [`validate_proximity_handle`].
///
/// It is a display label: never an identity, never an authorisation input (see the module notes).
#[derive(Debug, Clone, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub struct ProximityHandle {
    handle: String,
    origin: ProximityHandleOrigin,
}

/// `<adjective>-<noun>-<9 characters>` from `HMAC-SHA256(binding, label || sender key)`.
/// `binding` is the organisation's beacon salt; the tests pass another one to show what the
/// binding buys.
fn derive_generated_handle(binding: &[u8], sender_public_key: &Ed25519PublicKey) -> String {
    let mut message = Vec::with_capacity(GENERATED_HANDLE_LABEL.len() + sender_public_key.len());
    message.extend_from_slice(GENERATED_HANDLE_LABEL);
    message.extend_from_slice(sender_public_key);
    let digest = hmac_sha256(binding, &message);
    // The top 45 bits of digest[2..8], most significant character first.
    let mut bits = digest[2..8]
        .iter()
        .fold(0u64, |value, byte| (value << 8) | u64::from(*byte))
        >> 3;
    let mut suffix = [0u8; PROXIMITY_HANDLE_SUFFIX_CHARS];
    for slot in suffix.iter_mut().rev() {
        *slot = SUFFIX_ALPHABET[(bits & 31) as usize];
        bits >>= 5;
    }
    let mut handle = String::with_capacity(MAX_PROXIMITY_HANDLE_CHARS);
    handle.push_str(ADJECTIVES[usize::from(digest[0] & 31)]);
    handle.push('-');
    handle.push_str(NOUNS[usize::from(digest[1] & 31)]);
    handle.push('-');
    handle.extend(suffix.iter().map(|byte| char::from(*byte)));
    handle
}

impl ProximityHandle {
    /// A pseudonym the member picked. Refused, never repaired, when it is outside the grammar.
    pub fn dedicated(raw: &str) -> Result<Self, CoreError> {
        validate_proximity_handle(raw)?;
        Ok(Self {
            handle: raw.to_owned(),
            origin: ProximityHandleOrigin::Dedicated,
        })
    }

    /// The handle every device of one organisation derives for `sender_public_key`.
    /// `org_beacon_salt` is the salt [`crate::compute_proximity_beacon`] takes: the same key gives
    /// the same handle on every platform inside that organisation, and another one outside it.
    pub fn generated(org_beacon_salt: &[u8; 32], sender_public_key: &Ed25519PublicKey) -> Self {
        Self {
            handle: derive_generated_handle(org_beacon_salt, sender_public_key),
            origin: ProximityHandleOrigin::Generated,
        }
    }

    /// The dedicated handle when the member picked one, the generated one otherwise. An invalid
    /// dedicated handle is an error: it is not silently replaced, and it is never shown.
    pub fn resolve(
        dedicated: Option<&str>,
        org_beacon_salt: &[u8; 32],
        sender_public_key: &Ed25519PublicKey,
    ) -> Result<Self, CoreError> {
        match dedicated {
            Some(raw) => Self::dedicated(raw),
            None => Ok(Self::generated(org_beacon_salt, sender_public_key)),
        }
    }

    /// Rebuilds a handle received with its origin, for instance from a provisioned roster.
    /// A `generated` handle must be the one this organisation derives for this sender key.
    pub fn from_parts(
        raw: &str,
        origin: ProximityHandleOrigin,
        org_beacon_salt: &[u8; 32],
        sender_public_key: &Ed25519PublicKey,
    ) -> Result<Self, CoreError> {
        match origin {
            ProximityHandleOrigin::Dedicated => Self::dedicated(raw),
            ProximityHandleOrigin::Generated => {
                let expected = Self::generated(org_beacon_salt, sender_public_key);
                if expected.handle == raw {
                    Ok(expected)
                } else {
                    Err(CoreError::InvalidProximityHandle)
                }
            }
        }
    }

    pub fn as_str(&self) -> &str {
        &self.handle
    }

    pub fn origin(&self) -> ProximityHandleOrigin {
        self.origin
    }
}

/// The 64 lowercase hex characters a sender key is told apart by when handles are equal:
/// `SHA-256("kodera-proximity-fingerprint-v1:" || sender key)`. A prefix of it is shown.
pub fn proximity_key_fingerprint(sender_public_key: &Ed25519PublicKey) -> String {
    let mut input = Vec::with_capacity(FINGERPRINT_LABEL.len() + sender_public_key.len());
    input.extend_from_slice(FINGERPRINT_LABEL);
    input.extend_from_slice(sender_public_key);
    encode_hex(&sha256(&input))
}

/// What a roster view shows for one sender: the handle, and a fingerprint prefix of the signing
/// key when another sender of the same roster shows the same handle.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ProximityRosterLabel {
    pub sender_public_key: Ed25519PublicKey,
    pub handle: ProximityHandle,
    /// `None` when the handle is unique in the roster it was computed for.
    pub fingerprint: Option<String>,
}

impl ProximityRosterLabel {
    /// `handle`, or `handle [fingerprint]` when the handle alone would be ambiguous. The second
    /// form is a display string, not a handle: it is outside the handle grammar on purpose.
    pub fn display(&self) -> String {
        match &self.fingerprint {
            Some(fingerprint) => format!("{} [{}]", self.handle.as_str(), fingerprint),
            None => self.handle.as_str().to_owned(),
        }
    }
}

/// Labels for the senders of one roster, in the order given. When two or more distinct keys
/// resolve to the same handle, whatever its origin, each of them carries a fingerprint prefix:
/// [`MIN_PROXIMITY_FINGERPRINT_HEX_CHARS`] characters, lengthened two at a time until the
/// prefixes of that group differ. A key listed twice is one sender and does not collide with
/// itself. The result is for display; identity remains the key in `sender_public_key`.
pub fn disambiguate_proximity_handles(
    entries: &[(Ed25519PublicKey, ProximityHandle)],
) -> Vec<ProximityRosterLabel> {
    entries
        .iter()
        .map(|(sender_public_key, handle)| {
            let mut group: Vec<&Ed25519PublicKey> = entries
                .iter()
                .filter(|(_, other)| other.as_str() == handle.as_str())
                .map(|(key, _)| key)
                .collect();
            group.sort_unstable();
            group.dedup();
            let fingerprint = (group.len() > 1).then(|| {
                let fingerprints: Vec<String> = group
                    .iter()
                    .map(|key| proximity_key_fingerprint(key))
                    .collect();
                let mut length = MIN_PROXIMITY_FINGERPRINT_HEX_CHARS;
                while length < 64 && {
                    let mut prefixes: Vec<&str> =
                        fingerprints.iter().map(|full| &full[..length]).collect();
                    prefixes.sort_unstable();
                    prefixes.windows(2).any(|pair| pair[0] == pair[1])
                } {
                    length += 2;
                }
                proximity_key_fingerprint(sender_public_key)[..length].to_owned()
            });
            ProximityRosterLabel {
                sender_public_key: *sender_public_key,
                handle: handle.clone(),
                fingerprint,
            }
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::decode_hex;

    const VECTORS: &str = include_str!("../vectors/proximity-handle-v1.txt");

    struct RosterEntry {
        case: String,
        salt: [u8; 32],
        sender: [u8; 32],
        dedicated: Option<String>,
        handle: String,
        fingerprint: Option<String>,
    }

    #[derive(Default)]
    struct HandleVectors {
        bounds: Vec<(String, usize)>,
        origins: Vec<String>,
        adjectives: Vec<String>,
        nouns: Vec<String>,
        valid: Vec<String>,
        refused: Vec<(String, Vec<u8>)>,
        generated: Vec<([u8; 32], [u8; 32], String)>,
        rosters: Vec<RosterEntry>,
    }

    fn indexed_word(list: &mut Vec<String>, index: &str, word: &str, line: usize) {
        assert_eq!(
            index.parse::<usize>().ok(),
            Some(list.len()),
            "vectors line {line}: words are listed in index order"
        );
        list.push(word.to_owned());
    }

    fn bytes32(field: &str, line: usize) -> [u8; 32] {
        decode_hex(field)
            .ok()
            .and_then(|bytes| bytes.try_into().ok())
            .unwrap_or_else(|| panic!("vectors line {line}: {field:?} is not 32 bytes of hex"))
    }

    fn optional(field: &str) -> Option<String> {
        (field != "-").then(|| field.to_owned())
    }

    /// Strict: a line outside the grammar fails the test rather than being skipped.
    fn vectors() -> HandleVectors {
        let mut parsed = HandleVectors::default();
        for (index, line) in VECTORS.lines().enumerate() {
            let number = index + 1;
            if line.is_empty() || line.starts_with('#') {
                continue;
            }
            match line.split(' ').collect::<Vec<_>>().as_slice() {
                ["bound", name, value] => parsed.bounds.push((
                    (*name).to_owned(),
                    value
                        .parse()
                        .unwrap_or_else(|_| panic!("vectors line {number}: bound {value:?}")),
                )),
                ["origin", slug] => parsed.origins.push((*slug).to_owned()),
                ["adjective", index, word] => {
                    indexed_word(&mut parsed.adjectives, index, word, number)
                }
                ["noun", index, word] => indexed_word(&mut parsed.nouns, index, word, number),
                ["valid", handle] => parsed.valid.push((*handle).to_owned()),
                ["refuse", name, hex] => {
                    let bytes = if *hex == "-" {
                        Vec::new()
                    } else {
                        decode_hex(hex)
                            .unwrap_or_else(|_| panic!("vectors line {number}: hex {hex:?}"))
                    };
                    parsed.refused.push(((*name).to_owned(), bytes));
                }
                ["generated", salt, sender, handle] => parsed.generated.push((
                    bytes32(salt, number),
                    bytes32(sender, number),
                    (*handle).to_owned(),
                )),
                ["roster", case, salt, sender, dedicated, handle, fingerprint] => {
                    parsed.rosters.push(RosterEntry {
                        case: (*case).to_owned(),
                        salt: bytes32(salt, number),
                        sender: bytes32(sender, number),
                        dedicated: optional(dedicated),
                        handle: (*handle).to_owned(),
                        fingerprint: optional(fingerprint),
                    })
                }
                _ => panic!("vectors line {number} is not in the grammar: {line:?}"),
            }
        }
        parsed
    }

    #[test]
    fn shared_vectors_state_the_bounds_origins_and_words_this_crate_uses() {
        let shared = vectors();
        assert_eq!(
            shared.bounds,
            vec![
                ("min_chars".to_owned(), MIN_PROXIMITY_HANDLE_CHARS),
                ("max_chars".to_owned(), MAX_PROXIMITY_HANDLE_CHARS),
                (
                    "generated_suffix_chars".to_owned(),
                    PROXIMITY_HANDLE_SUFFIX_CHARS
                ),
                (
                    "generated_digest_bits".to_owned(),
                    PROXIMITY_HANDLE_DIGEST_BITS
                ),
                (
                    "min_fingerprint_hex_chars".to_owned(),
                    MIN_PROXIMITY_FINGERPRINT_HEX_CHARS
                ),
            ]
        );
        assert_eq!(
            PROXIMITY_HANDLE_DIGEST_BITS,
            5 + 5 + 5 * PROXIMITY_HANDLE_SUFFIX_CHARS
        );
        assert_eq!(shared.origins, vec!["dedicated", "generated"]);
        for slug in &shared.origins {
            assert_eq!(ProximityHandleOrigin::parse(slug).unwrap().as_slug(), slug);
        }
        for slug in ["", "Dedicated", "generated ", "random", "real-name"] {
            assert_eq!(
                ProximityHandleOrigin::parse(slug),
                Err(CoreError::InvalidProximityHandle)
            );
        }
        assert_eq!(shared.adjectives, ADJECTIVES);
        assert_eq!(shared.nouns, NOUNS);
    }

    #[test]
    fn every_shared_valid_handle_is_accepted_and_every_refused_one_is_refused() {
        let shared = vectors();
        assert!(shared.valid.len() >= 10 && shared.refused.len() >= 25);
        for handle in &shared.valid {
            assert_eq!(validate_proximity_handle(handle), Ok(()), "{handle}");
            let dedicated = ProximityHandle::dedicated(handle).unwrap();
            assert_eq!(dedicated.as_str(), handle);
            assert_eq!(dedicated.origin(), ProximityHandleOrigin::Dedicated);
        }
        for (name, bytes) in &shared.refused {
            let text = std::str::from_utf8(bytes)
                .unwrap_or_else(|_| panic!("refuse {name}: vectors hold valid UTF-8"));
            assert_eq!(
                validate_proximity_handle(text),
                Err(CoreError::InvalidProximityHandle),
                "{name}"
            );
            assert_eq!(
                ProximityHandle::dedicated(text),
                Err(CoreError::InvalidProximityHandle),
                "{name}"
            );
            assert_eq!(
                ProximityHandle::resolve(Some(text), &[1; 32], &[7; 32]),
                Err(CoreError::InvalidProximityHandle),
                "{name}: an invalid dedicated handle is never replaced silently"
            );
        }
    }

    /// Refusal mutation: one character of an accepted handle replaced by one outside the grammar,
    /// at every position, must be refused. A validator that only looked at the ends would pass.
    #[test]
    fn a_single_foreign_character_at_any_position_is_refused() {
        for handle in &vectors().valid {
            for position in 0..handle.len() {
                for foreign in ['A', '_', ' ', '.', 'é'] {
                    let mut mutated: Vec<char> = handle.chars().collect();
                    mutated[position] = foreign;
                    let mutated: String = mutated.into_iter().collect();
                    assert_eq!(
                        validate_proximity_handle(&mutated),
                        Err(CoreError::InvalidProximityHandle),
                        "{handle} with {foreign:?} at {position}"
                    );
                }
            }
        }
    }

    #[test]
    fn generated_handles_match_the_shared_vectors_and_always_validate() {
        let shared = vectors();
        assert!(shared.generated.len() >= 10);
        for (salt, sender, expected) in &shared.generated {
            let handle = ProximityHandle::generated(salt, sender);
            assert_eq!(handle.as_str(), expected);
            assert_eq!(handle.origin(), ProximityHandleOrigin::Generated);
            assert_eq!(validate_proximity_handle(handle.as_str()), Ok(()));
            assert_eq!(
                ProximityHandle::resolve(None, salt, sender).unwrap(),
                handle
            );
            assert_eq!(
                ProximityHandle::from_parts(
                    expected,
                    ProximityHandleOrigin::Generated,
                    salt,
                    sender
                ),
                Ok(handle)
            );
        }
        // The longest word pair with the full suffix is exactly the bound, and every pair fits.
        let longest = |words: &[&str]| words.iter().map(|word| word.len()).max().unwrap();
        assert_eq!(
            longest(&ADJECTIVES) + 1 + longest(&NOUNS) + 1 + PROXIMITY_HANDLE_SUFFIX_CHARS,
            MAX_PROXIMITY_HANDLE_CHARS
        );
        for adjective in ADJECTIVES {
            for noun in NOUNS {
                let widest = format!("{adjective}-{noun}-zzzzzzzzz");
                assert_eq!(validate_proximity_handle(&widest), Ok(()), "{widest}");
            }
        }
        for seed in 0..=255u8 {
            let handle = ProximityHandle::generated(&[seed; 32], &[seed.wrapping_add(1); 32]);
            assert_eq!(validate_proximity_handle(handle.as_str()), Ok(()));
            let suffix = handle.as_str().rsplit('-').next().unwrap();
            assert_eq!(suffix.len(), PROXIMITY_HANDLE_SUFFIX_CHARS);
            assert!(suffix.bytes().all(|byte| SUFFIX_ALPHABET.contains(&byte)));
        }
    }

    /// The organisation binding: one sender key, two organisations, two handles.
    #[test]
    fn the_same_sender_key_yields_different_handles_in_two_organisations() {
        let shared = vectors();
        let mut compared = 0;
        for (salt, sender, handle) in &shared.generated {
            for (other_salt, other_sender, other_handle) in &shared.generated {
                if sender == other_sender && salt != other_salt {
                    assert_ne!(handle, other_handle, "sender {}", encode_hex(sender));
                    assert_ne!(
                        ProximityHandle::generated(salt, sender),
                        ProximityHandle::generated(other_salt, sender)
                    );
                    // A handle derived in one organisation is not accepted as this sender's in another.
                    assert_eq!(
                        ProximityHandle::from_parts(
                            handle,
                            ProximityHandleOrigin::Generated,
                            other_salt,
                            sender
                        ),
                        Err(CoreError::InvalidProximityHandle)
                    );
                    compared += 1;
                }
            }
        }
        assert!(
            compared >= 10,
            "the vectors must hold each sender in two organisations"
        );
    }

    /// Refusal mutation on the binding itself: derive with the organisation removed (one fixed
    /// binding for everyone). No shared vector survives, and the two-organisation property above
    /// is exactly what breaks.
    #[test]
    fn a_derivation_without_the_organisation_binding_matches_no_shared_vector() {
        let unbound = |sender: &[u8; 32]| derive_generated_handle(&[], sender);
        for (salt, sender, expected) in &vectors().generated {
            assert_ne!(&unbound(sender), expected, "sender {}", encode_hex(sender));
            assert_eq!(&derive_generated_handle(salt, sender), expected);
        }
        assert_eq!(unbound(&[9; 32]), unbound(&[9; 32]));
    }

    #[test]
    fn a_generated_handle_belongs_to_its_key_and_a_dedicated_one_wins() {
        let salt = [0x42u8; 32];
        let sender = [9u8; 32];
        let other = [10u8; 32];
        let generated = ProximityHandle::generated(&salt, &sender);
        assert_ne!(generated, ProximityHandle::generated(&salt, &other));
        assert_eq!(
            ProximityHandle::from_parts(
                generated.as_str(),
                ProximityHandleOrigin::Generated,
                &salt,
                &other
            ),
            Err(CoreError::InvalidProximityHandle)
        );
        // A dedicated handle wins over the generated one and keeps its origin.
        let picked = ProximityHandle::resolve(Some("north-wing-3"), &salt, &sender).unwrap();
        assert_eq!(picked.as_str(), "north-wing-3");
        assert_eq!(picked.origin(), ProximityHandleOrigin::Dedicated);
        assert_eq!(
            ProximityHandle::from_parts(
                "north-wing-3",
                ProximityHandleOrigin::Dedicated,
                &salt,
                &other
            )
            .unwrap(),
            picked
        );
    }

    fn roster_cases(shared: &HandleVectors) -> Vec<(&str, Vec<&RosterEntry>)> {
        let mut cases: Vec<(&str, Vec<&RosterEntry>)> = Vec::new();
        for entry in &shared.rosters {
            match cases.last_mut() {
                Some((name, entries)) if *name == entry.case => entries.push(entry),
                _ => cases.push((&entry.case, vec![entry])),
            }
        }
        cases
    }

    #[test]
    fn equal_handles_in_a_roster_are_shown_with_a_key_fingerprint() {
        let shared = vectors();
        let cases = roster_cases(&shared);
        assert!(cases.len() >= 4);
        let mut disambiguated = 0;
        let mut extended = 0;
        for (name, entries) in cases {
            let resolved: Vec<(Ed25519PublicKey, ProximityHandle)> = entries
                .iter()
                .map(|entry| {
                    let handle = ProximityHandle::resolve(
                        entry.dedicated.as_deref(),
                        &entry.salt,
                        &entry.sender,
                    )
                    .unwrap();
                    assert_eq!(handle.as_str(), entry.handle, "{name}");
                    (entry.sender, handle)
                })
                .collect();
            let labels = disambiguate_proximity_handles(&resolved);
            assert_eq!(labels.len(), entries.len());
            for (label, entry) in labels.iter().zip(&entries) {
                assert_eq!(label.sender_public_key, entry.sender, "{name}");
                assert_eq!(label.fingerprint, entry.fingerprint, "{name}");
                let expected = match &entry.fingerprint {
                    Some(fingerprint) => format!("{} [{fingerprint}]", entry.handle),
                    None => entry.handle.clone(),
                };
                assert_eq!(label.display(), expected, "{name}");
                if let Some(fingerprint) = &entry.fingerprint {
                    assert!(proximity_key_fingerprint(&entry.sender).starts_with(fingerprint));
                    // The disambiguated display is not a handle and cannot be stored as one.
                    assert!(validate_proximity_handle(&label.display()).is_err());
                    disambiguated += 1;
                    extended += usize::from(fingerprint.len() > 8);
                }
            }
            // Every sender of a roster ends with a display of its own.
            let mut displays: Vec<String> = labels.iter().map(|label| label.display()).collect();
            displays.sort();
            displays.dedup();
            assert_eq!(displays.len(), entries.len(), "{name}");
        }
        assert!(disambiguated >= 7 && extended >= 2);
    }

    #[test]
    fn a_key_listed_twice_does_not_collide_with_itself() {
        let salt = [0x42u8; 32];
        let sender = [9u8; 32];
        let handle = ProximityHandle::generated(&salt, &sender);
        let labels = disambiguate_proximity_handles(&[(sender, handle.clone()), (sender, handle)]);
        assert!(labels.iter().all(|label| label.fingerprint.is_none()));
        assert!(disambiguate_proximity_handles(&[]).is_empty());
        assert_eq!(proximity_key_fingerprint(&sender).len(), 64);
    }
}
