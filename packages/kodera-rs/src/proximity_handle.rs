//! Pseudonymous sender labels for `#proximity` check-ins.
//!
//! A proximity frame carries its sender's device public key and nothing else about the person.
//! What a client shows next to a check-in is a [`ProximityHandle`]: a pseudonym the member picked
//! for this purpose ([`ProximityHandleOrigin::Dedicated`]) or one derived from the frame's sender
//! key ([`ProximityHandleOrigin::Generated`]). A real name is never required and never travels in
//! a frame. The frozen v1 wire format is untouched: a handle is display metadata held beside the
//! frame, never inside it.
//!
//! A handle proves neither identity nor membership. Two senders can share a generated handle, and
//! a dedicated one is whatever its member typed, within the grammar below.
//! `vectors/proximity-handle-v1.txt` states the grammar, the word lists and the vectors for the
//! Swift and Kotlin ports.

use crate::{sha256, CoreError, Ed25519PublicKey};

/// Fewest characters in a handle.
pub const MIN_PROXIMITY_HANDLE_CHARS: usize = 3;
/// Most characters in a handle. The grammar is ASCII, so characters and bytes agree.
pub const MAX_PROXIMITY_HANDLE_CHARS: usize = 24;

/// Hashed with the sender key to derive a generated handle. It labels a display value only: it is
/// not part of the frozen frame v1 and signs nothing.
const GENERATED_HANDLE_LABEL: &[u8] = b"kodera-proximity-handle-v1:";

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
#[derive(Debug, Clone, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub struct ProximityHandle {
    handle: String,
    origin: ProximityHandleOrigin,
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

    /// The handle every device derives for `sender_public_key`: the same key gives the same
    /// handle on every platform, with no directory lookup and no name.
    pub fn generated(sender_public_key: &Ed25519PublicKey) -> Self {
        let mut input = Vec::with_capacity(GENERATED_HANDLE_LABEL.len() + sender_public_key.len());
        input.extend_from_slice(GENERATED_HANDLE_LABEL);
        input.extend_from_slice(sender_public_key);
        let digest = sha256(&input);
        let handle = format!(
            "{}-{}-{:02x}{:02x}",
            ADJECTIVES[usize::from(digest[0] & 31)],
            NOUNS[usize::from(digest[1] & 31)],
            digest[2],
            digest[3]
        );
        Self {
            handle,
            origin: ProximityHandleOrigin::Generated,
        }
    }

    /// The dedicated handle when the member picked one, the generated one otherwise. An invalid
    /// dedicated handle is an error: it is not silently replaced, and it is never shown.
    pub fn resolve(
        dedicated: Option<&str>,
        sender_public_key: &Ed25519PublicKey,
    ) -> Result<Self, CoreError> {
        match dedicated {
            Some(raw) => Self::dedicated(raw),
            None => Ok(Self::generated(sender_public_key)),
        }
    }

    /// Rebuilds a handle received with its origin, for instance from a provisioned roster.
    /// A `generated` handle must be the one this sender key derives.
    pub fn from_parts(
        raw: &str,
        origin: ProximityHandleOrigin,
        sender_public_key: &Ed25519PublicKey,
    ) -> Result<Self, CoreError> {
        match origin {
            ProximityHandleOrigin::Dedicated => Self::dedicated(raw),
            ProximityHandleOrigin::Generated => {
                let expected = Self::generated(sender_public_key);
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

#[cfg(test)]
mod tests {
    use super::*;
    use crate::decode_hex;

    const VECTORS: &str = include_str!("../vectors/proximity-handle-v1.txt");

    #[derive(Default)]
    struct HandleVectors {
        bounds: Vec<(String, usize)>,
        origins: Vec<String>,
        adjectives: Vec<String>,
        nouns: Vec<String>,
        valid: Vec<String>,
        refused: Vec<(String, Vec<u8>)>,
        generated: Vec<([u8; 32], String)>,
    }

    fn indexed_word(list: &mut Vec<String>, index: &str, word: &str, line: usize) {
        assert_eq!(
            index.parse::<usize>().ok(),
            Some(list.len()),
            "vectors line {line}: words are listed in index order"
        );
        list.push(word.to_owned());
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
                ["generated", sender, handle] => {
                    let sender: [u8; 32] = decode_hex(sender)
                        .ok()
                        .and_then(|bytes| bytes.try_into().ok())
                        .unwrap_or_else(|| panic!("vectors line {number}: sender {sender:?}"));
                    parsed.generated.push((sender, (*handle).to_owned()));
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
            ]
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
                ProximityHandle::resolve(Some(text), &[7; 32]),
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
        assert!(shared.generated.len() >= 5);
        for (sender, expected) in &shared.generated {
            let handle = ProximityHandle::generated(sender);
            assert_eq!(handle.as_str(), expected);
            assert_eq!(handle.origin(), ProximityHandleOrigin::Generated);
            assert_eq!(validate_proximity_handle(handle.as_str()), Ok(()));
            assert_eq!(ProximityHandle::resolve(None, sender).unwrap(), handle);
            assert_eq!(
                ProximityHandle::from_parts(expected, ProximityHandleOrigin::Generated, sender),
                Ok(handle)
            );
        }
        // Every word pair and every suffix stays inside the grammar and the length bound.
        for adjective in ADJECTIVES {
            for noun in NOUNS {
                let longest = format!("{adjective}-{noun}-ffff");
                assert_eq!(validate_proximity_handle(&longest), Ok(()), "{longest}");
            }
        }
        for seed in 0..=255u8 {
            let handle = ProximityHandle::generated(&[seed; 32]);
            assert_eq!(validate_proximity_handle(handle.as_str()), Ok(()));
        }
    }

    #[test]
    fn a_handle_never_carries_the_sender_key_or_a_claimed_generated_value_from_another_key() {
        let sender = [9u8; 32];
        let other = [10u8; 32];
        let generated = ProximityHandle::generated(&sender);
        assert_ne!(generated, ProximityHandle::generated(&other));
        assert_eq!(
            ProximityHandle::from_parts(
                generated.as_str(),
                ProximityHandleOrigin::Generated,
                &other
            ),
            Err(CoreError::InvalidProximityHandle)
        );
        // A dedicated handle wins over the generated one and keeps its origin.
        let picked = ProximityHandle::resolve(Some("north-wing-3"), &sender).unwrap();
        assert_eq!(picked.as_str(), "north-wing-3");
        assert_eq!(picked.origin(), ProximityHandleOrigin::Dedicated);
        assert_eq!(
            ProximityHandle::from_parts("north-wing-3", ProximityHandleOrigin::Dedicated, &other)
                .unwrap(),
            picked
        );
    }
}
