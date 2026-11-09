//! Bounded local poll state and conservative connector metadata policies.

use crate::{validate_docs_host, CoreError, OrganisationId};
use std::collections::{BTreeMap, BTreeSet};

pub const MAX_CHANNEL_POLL_VOTERS: usize = 512;

/// Explicit Unicode 15.1 format-control set, verified against the installed Unicode database.
/// Keep exact UTF-8 identity; this is rejection rather than normalization/case folding.
fn forbidden_poll_character(value: char) -> bool {
    value.is_control()
        || matches!(value as u32,
        0x00ad | 0x0600..=0x0605 | 0x061c | 0x06dd | 0x070f | 0x0890..=0x0891 | 0x08e2 |
        0x180e | 0x200b..=0x200f | 0x202a..=0x202e | 0x2060..=0x2064 | 0x2066..=0x206f |
        0xfeff | 0xfff9..=0xfffb | 0x110bd | 0x110cd | 0x13430..=0x1343f |
        0x1bca0..=0x1bca3 | 0x1d173..=0x1d17a | 0xe0001 | 0xe0020..=0xe007f)
}

fn text(value: &str, maximum: usize) -> bool {
    !value.is_empty()
        && value.len() <= maximum
        && value == value.trim()
        && !value.chars().any(forbidden_poll_character)
}

/// Validated correlation metadata, not authentication or live channel membership.
pub fn validate_channel_poll_id(value: &str) -> Result<(), CoreError> {
    if text(value, 255) {
        Ok(())
    } else {
        Err(CoreError::InvalidPoll)
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ChannelPollOption {
    pub id: usize,
    pub label: String,
    pub vote_count: usize,
    pub percentage: usize,
}

/// Aggregate metadata deliberately contains no voter identifiers or individual ballots.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ChannelPollSnapshot {
    pub organisation_id: OrganisationId,
    pub channel_id: String,
    pub question: String,
    pub allow_multiple: bool,
    pub options: Vec<ChannelPollOption>,
    pub total_votes: usize,
    pub is_closed: bool,
}

/// Local deterministic vote bookkeeping, not proof of remote votes or voter membership.
/// The caller must authenticate authority before invoking this seam.
#[derive(Clone, PartialEq, Eq)]
pub struct ChannelPoll {
    organisation_id: OrganisationId,
    channel_id: String,
    question: String,
    labels: Vec<String>,
    allow_multiple: bool,
    is_closed: bool,
    voters: BTreeMap<OrganisationId, BTreeSet<usize>>,
    voter_capacity: usize,
}

impl std::fmt::Debug for ChannelPoll {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("ChannelPoll")
            .field("snapshot", &self.snapshot())
            .finish()
    }
}

impl ChannelPoll {
    pub fn new(
        organisation_id: OrganisationId,
        channel_id: &str,
        question: &str,
        labels: &[String],
        allow_multiple: bool,
        voter_capacity: usize,
    ) -> Result<Self, CoreError> {
        validate_channel_poll_id(channel_id)?;
        if !text(question, 280)
            || !(2..=10).contains(&labels.len())
            || labels.iter().any(|label| !text(label, 120))
            || labels.iter().collect::<BTreeSet<_>>().len() != labels.len()
        {
            return Err(CoreError::InvalidPoll);
        }
        if !(1..=MAX_CHANNEL_POLL_VOTERS).contains(&voter_capacity) {
            return Err(CoreError::InvalidCapacity);
        }
        Ok(Self {
            organisation_id,
            channel_id: channel_id.to_owned(),
            question: question.to_owned(),
            labels: labels.to_vec(),
            allow_multiple,
            is_closed: false,
            voters: BTreeMap::new(),
            voter_capacity,
        })
    }

    /// A canonical non-nil UUID deduplicates a voter; it is not an identity credential.
    /// Empty selections remove a ballot, including at capacity. All refusal paths are transactional.
    pub fn vote(
        &mut self,
        organisation_id: &OrganisationId,
        channel_id: &str,
        voter_id: &str,
        selections: &[usize],
    ) -> Result<(), CoreError> {
        self.check_scope(organisation_id, channel_id)?;
        if self.is_closed {
            return Err(CoreError::PollClosed);
        }
        let voter = OrganisationId::parse(voter_id).map_err(|_| CoreError::InvalidPollVote)?;
        if selections.len() > self.labels.len()
            || selections.iter().any(|&index| index >= self.labels.len())
        {
            return Err(CoreError::InvalidPollVote);
        }
        let ballot: BTreeSet<usize> = selections.iter().copied().collect();
        if ballot.len() != selections.len() || (!self.allow_multiple && ballot.len() > 1) {
            return Err(CoreError::InvalidPollVote);
        }
        if ballot.is_empty() {
            self.voters.remove(&voter);
            return Ok(());
        }
        if !self.voters.contains_key(&voter) && self.voters.len() == self.voter_capacity {
            return Err(CoreError::CapacityExceeded);
        }
        self.voters.insert(voter, ballot);
        Ok(())
    }

    pub fn close(
        &mut self,
        organisation_id: &OrganisationId,
        channel_id: &str,
    ) -> Result<(), CoreError> {
        self.check_scope(organisation_id, channel_id)?;
        if self.is_closed {
            return Err(CoreError::PollClosed);
        }
        self.is_closed = true;
        Ok(())
    }

    fn check_scope(&self, organisation: &OrganisationId, channel: &str) -> Result<(), CoreError> {
        if organisation != &self.organisation_id || channel != self.channel_id {
            return Err(CoreError::OrganisationMismatch);
        }
        Ok(())
    }

    pub fn snapshot(&self) -> ChannelPollSnapshot {
        let total = self.voters.len();
        let options = self
            .labels
            .iter()
            .enumerate()
            .map(|(id, label)| {
                let count = self
                    .voters
                    .values()
                    .filter(|ballot| ballot.contains(&id))
                    .count();
                ChannelPollOption {
                    id,
                    label: label.clone(),
                    vote_count: count,
                    percentage: if total == 0 {
                        0
                    } else {
                        (count * 100 + total / 2) / total
                    },
                }
            })
            .collect();
        ChannelPollSnapshot {
            organisation_id: self.organisation_id.clone(),
            channel_id: self.channel_id.clone(),
            question: self.question.clone(),
            allow_multiple: self.allow_multiple,
            options,
            total_votes: total,
            is_closed: self.is_closed,
        }
    }
}

/// Structural admission only, not IBAN checksum/country-length/account verification.
/// Only ASCII spaces are removed; lowercase, other whitespace and punctuation fail closed.
/// Returns exactly the first four and last four characters, masking every middle character.
pub fn redact_iban(raw: &str) -> Result<String, CoreError> {
    if raw.len() > 128 {
        return Err(CoreError::InvalidIban);
    }
    let mut bytes = [0u8; 34];
    let mut length = 0;
    for byte in raw.bytes().filter(|&byte| byte != b' ') {
        if length == bytes.len() || !(byte.is_ascii_uppercase() || byte.is_ascii_digit()) {
            return Err(CoreError::InvalidIban);
        }
        bytes[length] = byte;
        length += 1;
    }
    if !(15..=34).contains(&length)
        || !bytes[..2].iter().all(u8::is_ascii_uppercase)
        || !bytes[2..4].iter().all(u8::is_ascii_digit)
    {
        return Err(CoreError::InvalidIban);
    }
    // Every stored byte is admitted ASCII, so conversion cannot introduce unsafe text.
    let prefix = std::str::from_utf8(&bytes[..4]).map_err(|_| CoreError::InvalidIban)?;
    let suffix =
        std::str::from_utf8(&bytes[length - 4..length]).map_err(|_| CoreError::InvalidIban)?;
    let masked = format!("{prefix}{}{suffix}", "*".repeat(length - 8));
    Ok(masked
        .as_bytes()
        .chunks(4)
        .map(|chunk| String::from_utf8_lossy(chunk))
        .collect::<Vec<_>>()
        .join(" "))
}

/// Conservative HTTPS post metadata admission. Any public-DNS host can be a Mastodon deployment;
/// syntax alone therefore cannot assert platform identity, resolved addresses or SSRF safety.
/// No query/fragment/percent encoding or navigation/fetch/redirect behavior is implemented.
pub fn validate_connector_post_url(raw_url: &str) -> Result<String, CoreError> {
    if raw_url.len() > 2048
        || !raw_url.bytes().all(|byte| (0x21..=0x7e).contains(&byte))
        || raw_url
            .bytes()
            .any(|byte| matches!(byte, b'?' | b'#' | b'%' | b'\\'))
    {
        return Err(CoreError::InvalidConnectorUrl);
    }
    let remainder = raw_url
        .strip_prefix("https://")
        .ok_or(CoreError::InvalidConnectorUrl)?;
    let (authority, tail) = remainder
        .split_once('/')
        .ok_or(CoreError::InvalidConnectorUrl)?;
    let host = authority.strip_suffix(":443").unwrap_or(authority);
    validate_docs_host(host).map_err(|_| CoreError::InvalidConnectorUrl)?;
    if tail.is_empty()
        || tail.starts_with('/')
        || tail.contains("//")
        || tail
            .split('/')
            .any(|segment| segment == "." || segment == "..")
        || !tail.bytes().all(|byte| {
            byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'.' | b'_' | b'~' | b'/' | b'@')
        })
    {
        return Err(CoreError::InvalidConnectorUrl);
    }
    Ok(format!("https://{host}/{tail}"))
}

#[cfg(test)]
mod tests {
    use super::*;
    const ORG: &str = "11111111-1111-4111-8111-111111111111";
    fn org() -> OrganisationId {
        OrganisationId::parse(ORG).unwrap()
    }
    fn voter(index: usize) -> String {
        format!("00000000-0000-4000-8000-{index:012x}")
    }
    fn poll(multi: bool, capacity: usize) -> ChannelPoll {
        ChannelPoll::new(
            org(),
            "channel",
            "Choose an option?",
            &["One".to_owned(), "Two".to_owned(), "Three".to_owned()],
            multi,
            capacity,
        )
        .unwrap()
    }
    #[test]
    fn validates_bounds_utf8_unique_labels_and_capacity_before_copy() {
        for question in [
            "",
            " ",
            " Question",
            "Question\n",
            &"a".repeat(281),
            &"🧭".repeat(71),
        ] {
            assert_eq!(
                ChannelPoll::new(
                    org(),
                    "channel",
                    question,
                    &["A".into(), "B".into()],
                    false,
                    512
                ),
                Err(CoreError::InvalidPoll)
            );
        }
        for labels in [
            vec!["A".into()],
            vec!["A".into(), "A".into()],
            vec!["A".into(), " ".into()],
            vec!["A".into(), "x".repeat(121)],
            (0..11).map(|i| i.to_string()).collect(),
        ] {
            assert!(ChannelPoll::new(org(), "channel", "Question", &labels, false, 512).is_err());
        }
        let labels: Vec<String> = (0..10)
            .map(|i| format!("{}{}", i, "x".repeat(119)))
            .collect();
        assert!(ChannelPoll::new(
            org(),
            &"a".repeat(255),
            &"a".repeat(280),
            &labels,
            true,
            512
        )
        .is_ok());
        for capacity in [0, 513, usize::MAX] {
            assert_eq!(
                ChannelPoll::new(
                    org(),
                    "channel",
                    "Question",
                    &["A".into(), "B".into()],
                    false,
                    capacity
                ),
                Err(CoreError::InvalidCapacity)
            );
        }
    }
    #[test]
    fn one_voter_replaces_atomically_without_double_counting() {
        let mut state = poll(false, 512);
        state.vote(&org(), "channel", &voter(1), &[0]).unwrap();
        state.vote(&org(), "channel", &voter(1), &[0]).unwrap();
        state.vote(&org(), "channel", &voter(1), &[2]).unwrap();
        let snapshot = state.snapshot();
        assert_eq!(snapshot.total_votes, 1);
        assert_eq!(
            snapshot
                .options
                .iter()
                .map(|o| o.vote_count)
                .collect::<Vec<_>>(),
            [0, 0, 1]
        );
        assert_eq!(snapshot.options[2].percentage, 100);
        let before = state.clone();
        for invalid in [&[0, 1][..], &[3][..], &[usize::MAX][..], &[0, 0][..]] {
            assert_eq!(
                state.vote(&org(), "channel", &voter(1), invalid),
                Err(CoreError::InvalidPollVote)
            );
            assert_eq!(state, before);
        }
        state.vote(&org(), "channel", &voter(1), &[]).unwrap();
        assert_eq!(state.snapshot().total_votes, 0);
        assert!(state.snapshot().options.iter().all(|o| o.percentage == 0));
    }
    #[test]
    fn multi_choice_counts_voters_not_selections_with_half_up_rounding() {
        let mut state = poll(true, 512);
        for index in 1..=3 {
            state
                .vote(
                    &org(),
                    "channel",
                    &voter(index),
                    if index == 1 { &[0, 1] } else { &[1] },
                )
                .unwrap();
        }
        let result = state.snapshot();
        assert_eq!(result.total_votes, 3);
        assert_eq!(
            result
                .options
                .iter()
                .map(|o| o.percentage)
                .collect::<Vec<_>>(),
            [33, 100, 0]
        );
        assert!(result.options.iter().map(|o| o.percentage).sum::<usize>() > 100);
        state.vote(&org(), "channel", &voter(2), &[0]).unwrap();
        assert_eq!(state.snapshot().options[0].percentage, 67);
        for index in 4..=8 {
            state.vote(&org(), "channel", &voter(index), &[2]).unwrap();
        }
        state.vote(&org(), "channel", &voter(2), &[2]).unwrap();
        assert_eq!(state.snapshot().options[0].percentage, 13);
    }
    #[test]
    fn full_registry_allows_existing_replacement_and_removal_but_refuses_new_voters() {
        let mut state = poll(true, 512);
        for index in 1..=512 {
            state.vote(&org(), "channel", &voter(index), &[0]).unwrap();
        }
        assert_eq!(state.snapshot().total_votes, 512);
        let before = state.clone();
        assert_eq!(
            state.vote(&org(), "channel", &voter(513), &[0]),
            Err(CoreError::CapacityExceeded)
        );
        assert_eq!(state, before);
        state.vote(&org(), "channel", &voter(1), &[1]).unwrap();
        state.vote(&org(), "channel", &voter(1), &[]).unwrap();
        state.vote(&org(), "channel", &voter(513), &[1]).unwrap();
        assert_eq!(state.snapshot().total_votes, 512);
    }
    #[test]
    fn scope_and_voter_refusals_are_transactional_and_debug_has_no_ballots() {
        let mut state = poll(true, 512);
        state.vote(&org(), "channel", &voter(1), &[0]).unwrap();
        let before = state.clone();
        for bad in [
            "",
            "member",
            "11111111-1111-4111-8111-11111111111A",
            "00000000-0000-0000-0000-000000000000",
        ] {
            assert_eq!(
                state.vote(&org(), "channel", bad, &[0]),
                Err(CoreError::InvalidPollVote)
            );
            assert_eq!(state, before);
        }
        let other = OrganisationId::parse("22222222-2222-4222-8222-222222222222").unwrap();
        assert_eq!(
            state.vote(&other, "channel", &voter(1), &[1]),
            Err(CoreError::OrganisationMismatch)
        );
        assert_eq!(
            state.vote(&org(), "other", &voter(1), &[1]),
            Err(CoreError::OrganisationMismatch)
        );
        assert_eq!(state, before);
        assert!(!format!("{state:?}").contains(&voter(1)));
    }
    #[test]
    fn closed_poll_rejects_every_vote_and_reclose_without_mutation() {
        let mut state = poll(true, 2);
        state.vote(&org(), "channel", &voter(1), &[0]).unwrap();
        state.close(&org(), "channel").unwrap();
        let before = state.clone();
        for choices in [&[][..], &[1][..], &[0, 1][..], &[999][..]] {
            assert_eq!(
                state.vote(&org(), "channel", &voter(1), choices),
                Err(CoreError::PollClosed)
            );
            assert_eq!(state, before);
        }
        assert_eq!(state.close(&org(), "channel"), Err(CoreError::PollClosed));
        assert_eq!(state, before);
    }
    #[test]
    fn iban_mask_preserves_only_structure_and_last_four_with_canonical_grouping() {
        let raw = "FR7612345678901234567890189";
        let result = redact_iban(raw).unwrap();
        assert_eq!(result, "FR76 **** **** **** **** ***0 189");
        assert_eq!(
            redact_iban("FR76 1234 5678 9012 3456 7890 189").unwrap(),
            result
        );
        assert!(!result.contains(raw));
        for length in [15, 34] {
            let raw = format!("GB12{}9876", "A".repeat(length - 8));
            let mask = redact_iban(&raw).unwrap().replace(' ', "");
            assert_eq!(mask.len(), length);
            assert!(mask.starts_with("GB12") && mask.ends_with("9876"));
            assert!(mask[4..length - 4].chars().all(|c| c == '*'));
        }
    }
    #[test]
    fn iban_refuses_noncanonical_format_without_echo_or_unbounded_work() {
        for invalid in [
            "",
            "FR761234567890",
            "FR76123456789012345678901234567890123",
            "fr761234567890123",
            "F1761234567890123",
            "FRA61234567890123",
            "FR76\t1234567890123",
            "FR76\n1234567890123",
            "FR76é1234567890123",
            "FR76-1234567890123",
        ] {
            assert_eq!(redact_iban(invalid), Err(CoreError::InvalidIban));
        }
        assert_eq!(redact_iban(&" ".repeat(129)), Err(CoreError::InvalidIban));
    }
    #[test]
    fn connector_accepts_public_platform_paths_and_mastodon_handles_as_metadata() {
        for host in [
            "github.com",
            "notion.so",
            "drive.google.com",
            "x.com",
            "twitter.com",
            "instagram.com",
            "social.example.org",
        ] {
            let path = if host == "social.example.org" {
                "@member/42"
            } else {
                "team/post-1_2~a"
            };
            assert_eq!(
                validate_connector_post_url(&format!("https://{host}:443/{path}")).unwrap(),
                format!("https://{host}/{path}")
            );
        }
    }
    #[test]
    fn connector_refuses_authority_path_and_encoded_normalization_ambiguity() {
        for raw in [
            "http://github.com/team/post",
            "HTTPS://github.com/team/post",
            "https://GitHub.com/team/post",
            "https://user@github.com/team/post",
            "https://@github.com/team/post",
            "https://github.com:444/team/post",
            "https://github.com:0443/team/post",
            "https://github.com:/team/post",
            "https://localhost/@member/1",
            "https://a.local/post",
            "https://a.internal/post",
            "https://127.0.0.1/post",
            "https://[::1]/post",
            "https://0x7f.0.0.1/post",
            "https://github.com/post#",
            "https://github.com/post?",
            "https://github.com/post?token=private",
            "https://github.com/post%2fsecret",
            "https://github.com/../post",
            "https://github.com/./post",
            "https://github.com//post",
            "https://github.com/post;session",
            "https://github.com/post\\secret",
            "https://github.com/",
            "https://github.com/post\n",
        ] {
            assert_eq!(
                validate_connector_post_url(raw),
                Err(CoreError::InvalidConnectorUrl),
                "{raw:?}"
            );
        }
        assert_eq!(
            validate_connector_post_url(&"a".repeat(2049)),
            Err(CoreError::InvalidConnectorUrl)
        );
    }
    #[test]
    fn invisible_format_controls_are_refused_but_unicode_letters_and_emoji_survive() {
        for value in [
            "\u{200b}",
            "Title\u{202e}",
            "\u{feff}Title",
            "Soft\u{ad}hyphen",
            "\u{e0001}",
            "\u{13430}",
        ] {
            assert_eq!(
                ChannelPoll::new(
                    org(),
                    "channel",
                    value,
                    &["One".into(), "Two".into()],
                    false,
                    512
                ),
                Err(CoreError::InvalidPoll)
            );
            assert_eq!(
                ChannelPoll::new(
                    org(),
                    value,
                    "Question?",
                    &["One".into(), "Two".into()],
                    false,
                    512
                ),
                Err(CoreError::InvalidPoll)
            );
            assert_eq!(
                ChannelPoll::new(
                    org(),
                    "channel",
                    "Question?",
                    &[value.into(), "Two".into()],
                    false,
                    512
                ),
                Err(CoreError::InvalidPoll)
            );
        }
        let result = ChannelPoll::new(
            org(),
            "channel",
            "Choose 🧭?",
            &["Café".into(), "🧭".into()],
            false,
            512,
        )
        .unwrap();
        assert_eq!(result.snapshot().options[0].label, "Café");
        assert_eq!(result.snapshot().options[1].label, "🧭");
    }
}
