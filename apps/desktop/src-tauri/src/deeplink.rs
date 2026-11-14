//! Strict deep-link parser and origin-fenced admission router for `kodera://` and `matrix:`.
//!
//! Security invariants:
//! - Payloads exceeding [`MAX_DEEP_LINK_BYTES`] are refused before allocation.
//! - Control characters, non-ASCII characters, whitespace, fragments, backslashes, percent-encoded
//!   delimiters, path traversal (`..`), and embedded credentials (`@`) fail closed.
//! - Only canonical lowercase `kodera` (`kodera://workspace/...`, `kodera://invite/...`,
//!   `kodera://call/...`) and `matrix` (`matrix:r/...`, `matrix:roomid/...`, `matrix:u/...`)
//!   schemes are admitted; `javascript:`, `data:`, `file:`, `http:`, and `https:` are refused.
//! - Every Matrix homeserver domain, `via` server, and optional Kodera `origin` parameter must
//!   belong to the caller's [`DeepLinkAdmissionPolicy`] allowlist.

use core::fmt;
use kodera_rs::validate_docs_host;
use std::collections::BTreeSet;

/// Maximum raw UTF-8 byte length accepted by the deep-link router.
pub const MAX_DEEP_LINK_BYTES: usize = 512;

/// Maximum number of admitted homeserver/workspace domains held in a policy.
pub const MAX_ADMITTED_DEEP_LINK_DOMAINS: usize = 32;

/// Maximum number of `via` homeserver hints accepted on a Matrix room deep link.
pub const MAX_MATRIX_VIA_SERVERS: usize = 3;

/// Default first-party Matrix/workspace domains admitted when no custom tenant list is supplied.
pub const DEFAULT_ADMITTED_DOMAINS: [&str; 2] = ["community.kodera.io", "kodera.io"];

/// Closed refusal codes for deep-link parsing and origin admission.
/// Never interpolates untrusted URI input.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum DeepLinkError {
    EmptyUri,
    PayloadTooLarge,
    ControlCharacter,
    UnsupportedScheme,
    EmbeddedCredentials,
    PathTraversal,
    UntrustedOrigin,
    MalformedUri,
    InvalidQuery,
    CapacityExceeded,
}

impl fmt::Display for DeepLinkError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        let code = match self {
            Self::EmptyUri => "empty_uri",
            Self::PayloadTooLarge => "payload_too_large",
            Self::ControlCharacter => "control_character",
            Self::UnsupportedScheme => "unsupported_scheme",
            Self::EmbeddedCredentials => "embedded_credentials",
            Self::PathTraversal => "path_traversal",
            Self::UntrustedOrigin => "untrusted_origin",
            Self::MalformedUri => "malformed_uri",
            Self::InvalidQuery => "invalid_query",
            Self::CapacityExceeded => "capacity_exceeded",
        };
        f.write_str(code)
    }
}

impl std::error::Error for DeepLinkError {}

/// Explicit allowlist of canonical lowercase Matrix and workspace FQDNs.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DeepLinkAdmissionPolicy {
    admitted_domains: BTreeSet<String>,
}

impl Default for DeepLinkAdmissionPolicy {
    fn default() -> Self {
        Self::kodera_default()
    }
}

impl DeepLinkAdmissionPolicy {
    /// Default policy admitting `kodera.io` and `community.kodera.io`.
    pub fn kodera_default() -> Self {
        let mut admitted_domains = BTreeSet::new();
        for domain in DEFAULT_ADMITTED_DOMAINS {
            admitted_domains.insert(domain.to_owned());
        }
        Self { admitted_domains }
    }

    /// Constructs a policy from an explicit iterator of canonical public FQDNs.
    pub fn with_domains<'a>(
        domains: impl IntoIterator<Item = &'a str>,
    ) -> Result<Self, DeepLinkError> {
        let mut policy = Self {
            admitted_domains: BTreeSet::new(),
        };
        for domain in domains {
            policy.add_domain(domain)?;
        }
        if policy.admitted_domains.is_empty() {
            return Err(DeepLinkError::UntrustedOrigin);
        }
        Ok(policy)
    }

    /// Adds a canonical lowercase public FQDN to the admission allowlist.
    pub fn add_domain(&mut self, domain: &str) -> Result<(), DeepLinkError> {
        if !self.admitted_domains.contains(domain)
            && self.admitted_domains.len() >= MAX_ADMITTED_DEEP_LINK_DOMAINS
        {
            return Err(DeepLinkError::CapacityExceeded);
        }
        validate_admissible_public_domain(domain)?;
        self.admitted_domains.insert(domain.to_owned());
        Ok(())
    }

    pub fn is_domain_admitted(&self, domain: &str) -> bool {
        self.admitted_domains.contains(domain)
    }

    pub fn admitted_domains(&self) -> &BTreeSet<String> {
        &self.admitted_domains
    }
}

/// Admitted Matrix URI action (`?action=...`).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum MatrixAction {
    Join,
    View,
    Chat,
}

impl MatrixAction {
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::Join => "join",
            Self::View => "view",
            Self::Chat => "chat",
        }
    }
}

/// Canonical Matrix entity addressed by a `matrix:` URI (MSC2312).
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum MatrixTarget {
    RoomAlias {
        alias: String,
        domain: String,
        canonical_id: String,
    },
    RoomId {
        room_id: String,
        domain: String,
        canonical_id: String,
    },
    User {
        localpart: String,
        domain: String,
        canonical_id: String,
    },
}

impl MatrixTarget {
    pub fn domain(&self) -> &str {
        match self {
            Self::RoomAlias { domain, .. }
            | Self::RoomId { domain, .. }
            | Self::User { domain, .. } => domain,
        }
    }

    pub fn canonical_id(&self) -> &str {
        match self {
            Self::RoomAlias { canonical_id, .. }
            | Self::RoomId { canonical_id, .. }
            | Self::User { canonical_id, .. } => canonical_id,
        }
    }
}

/// Validated, origin-admitted `matrix:` deep link.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct MatrixDeepLink {
    pub target: MatrixTarget,
    pub action: Option<MatrixAction>,
    pub via: Vec<String>,
    pub canonical_uri: String,
}

/// Validated, origin-admitted `kodera://` deep link.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum KoderaDeepLink {
    Workspace {
        workspace: String,
        channel: Option<String>,
        origin: Option<String>,
        canonical_uri: String,
    },
    Invite {
        workspace: Option<String>,
        invite_code: String,
        origin: Option<String>,
        canonical_uri: String,
    },
    Call {
        workspace: Option<String>,
        room: String,
        origin: Option<String>,
        canonical_uri: String,
    },
}

impl KoderaDeepLink {
    pub fn canonical_uri(&self) -> &str {
        match self {
            Self::Workspace { canonical_uri, .. }
            | Self::Invite { canonical_uri, .. }
            | Self::Call { canonical_uri, .. } => canonical_uri,
        }
    }
}

/// Admitted deep-link route ready for workspace/room navigation.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum AdmittedDeepLink {
    Matrix(MatrixDeepLink),
    Kodera(KoderaDeepLink),
}

impl AdmittedDeepLink {
    pub fn canonical_uri(&self) -> &str {
        match self {
            Self::Matrix(link) => &link.canonical_uri,
            Self::Kodera(link) => link.canonical_uri(),
        }
    }
}

/// Parses and validates a raw deep-link URI against [`DeepLinkAdmissionPolicy`].
pub fn route_deep_link(
    raw_uri: &str,
    policy: &DeepLinkAdmissionPolicy,
) -> Result<AdmittedDeepLink, DeepLinkError> {
    if raw_uri.is_empty() {
        return Err(DeepLinkError::EmptyUri);
    }
    if raw_uri.len() > MAX_DEEP_LINK_BYTES {
        return Err(DeepLinkError::PayloadTooLarge);
    }
    if raw_uri.chars().any(char::is_control) {
        return Err(DeepLinkError::ControlCharacter);
    }
    if !raw_uri.is_ascii() || raw_uri.bytes().any(|b| b.is_ascii_whitespace()) {
        return Err(DeepLinkError::MalformedUri);
    }

    let Some((scheme, rest)) = raw_uri.split_once(':') else {
        return Err(DeepLinkError::MalformedUri);
    };
    if !is_rfc3986_scheme_syntax(scheme) {
        return Err(DeepLinkError::MalformedUri);
    }
    if scheme != "matrix" && scheme != "kodera" {
        return Err(DeepLinkError::UnsupportedScheme);
    }

    inspect_forbidden_delimiters(rest)?;

    match scheme {
        "matrix" => parse_matrix_deep_link(rest, policy).map(AdmittedDeepLink::Matrix),
        "kodera" => parse_kodera_deep_link(rest, policy).map(AdmittedDeepLink::Kodera),
        _ => Err(DeepLinkError::UnsupportedScheme),
    }
}

fn is_rfc3986_scheme_syntax(scheme: &str) -> bool {
    let mut bytes = scheme.bytes();
    let Some(first) = bytes.next() else {
        return false;
    };
    first.is_ascii_alphabetic()
        && bytes.all(|b| b.is_ascii_alphanumeric() || matches!(b, b'+' | b'-' | b'.'))
}

fn inspect_forbidden_delimiters(rest: &str) -> Result<(), DeepLinkError> {
    let bytes = rest.as_bytes();
    let mut idx = 0;
    while idx < bytes.len() {
        match bytes[idx] {
            b'%' => {
                if idx + 2 >= bytes.len() {
                    return Err(DeepLinkError::MalformedUri);
                }
                let Some(decoded) = decode_hex_pair(bytes[idx + 1], bytes[idx + 2]) else {
                    return Err(DeepLinkError::MalformedUri);
                };
                if decoded.is_ascii_control() {
                    return Err(DeepLinkError::ControlCharacter);
                }
                if matches!(decoded, b'.' | b'/' | b'\\') {
                    return Err(DeepLinkError::PathTraversal);
                }
                if decoded == b'@' {
                    return Err(DeepLinkError::EmbeddedCredentials);
                }
                return Err(DeepLinkError::MalformedUri);
            }
            b'\\' => return Err(DeepLinkError::PathTraversal),
            b'@' => return Err(DeepLinkError::EmbeddedCredentials),
            b'#' => return Err(DeepLinkError::MalformedUri),
            _ => {}
        }
        idx += 1;
    }
    Ok(())
}

fn decode_hex_pair(hi: u8, lo: u8) -> Option<u8> {
    let nibble = |b: u8| match b {
        b'0'..=b'9' => Some(b - b'0'),
        b'a'..=b'f' => Some(b - b'a' + 10),
        b'A'..=b'F' => Some(b - b'A' + 10),
        _ => None,
    };
    Some((nibble(hi)? << 4) | nibble(lo)?)
}

fn parse_matrix_deep_link(
    rest: &str,
    policy: &DeepLinkAdmissionPolicy,
) -> Result<MatrixDeepLink, DeepLinkError> {
    if rest.starts_with("//") {
        return Err(DeepLinkError::MalformedUri);
    }
    let (opaque_path, query_opt) = match rest.split_once('?') {
        Some((path, query)) => (path, Some(query)),
        None => (rest, None),
    };
    if opaque_path.is_empty() || opaque_path.starts_with('/') || opaque_path.ends_with('/') {
        return Err(DeepLinkError::MalformedUri);
    }
    for segment in opaque_path.split('/') {
        if segment == "." || segment == ".." || segment.contains("..") {
            return Err(DeepLinkError::PathTraversal);
        }
    }
    let Some((kind, target_spec)) = opaque_path.split_once('/') else {
        return Err(DeepLinkError::MalformedUri);
    };
    if target_spec.contains('/') {
        return Err(DeepLinkError::MalformedUri);
    }
    let Some((identifier, domain)) = target_spec.split_once(':') else {
        return Err(DeepLinkError::MalformedUri);
    };
    if identifier == "." || identifier == ".." || identifier.contains("..") {
        return Err(DeepLinkError::PathTraversal);
    }

    ensure_admitted_domain(domain, policy)?;

    let (target, is_room) = match kind {
        "r" => {
            if !is_valid_room_alias_localpart(identifier) {
                return Err(DeepLinkError::MalformedUri);
            }
            (
                MatrixTarget::RoomAlias {
                    alias: identifier.to_owned(),
                    domain: domain.to_owned(),
                    canonical_id: format!("#{identifier}:{domain}"),
                },
                true,
            )
        }
        "roomid" => {
            if !is_valid_room_id_localpart(identifier) {
                return Err(DeepLinkError::MalformedUri);
            }
            (
                MatrixTarget::RoomId {
                    room_id: identifier.to_owned(),
                    domain: domain.to_owned(),
                    canonical_id: format!("!{identifier}:{domain}"),
                },
                true,
            )
        }
        "u" => {
            if !is_valid_user_localpart(identifier) {
                return Err(DeepLinkError::MalformedUri);
            }
            (
                MatrixTarget::User {
                    localpart: identifier.to_owned(),
                    domain: domain.to_owned(),
                    canonical_id: format!("@{identifier}:{domain}"),
                },
                false,
            )
        }
        _ => return Err(DeepLinkError::MalformedUri),
    };

    let (action, via) = parse_matrix_query(query_opt, is_room, policy)?;
    let mut canonical_uri = format!("matrix:{kind}/{identifier}:{domain}");
    let mut query_parts = Vec::new();
    if let Some(act) = action {
        query_parts.push(format!("action={}", act.as_str()));
    }
    for server in &via {
        query_parts.push(format!("via={server}"));
    }
    if !query_parts.is_empty() {
        canonical_uri.push('?');
        canonical_uri.push_str(&query_parts.join("&"));
    }

    Ok(MatrixDeepLink {
        target,
        action,
        via,
        canonical_uri,
    })
}

fn parse_matrix_query(
    query_opt: Option<&str>,
    is_room: bool,
    policy: &DeepLinkAdmissionPolicy,
) -> Result<(Option<MatrixAction>, Vec<String>), DeepLinkError> {
    let Some(query) = query_opt else {
        return Ok((None, Vec::new()));
    };
    if query.is_empty() {
        return Err(DeepLinkError::InvalidQuery);
    }
    let mut action: Option<MatrixAction> = None;
    let mut via: Vec<String> = Vec::new();
    let pairs: Vec<&str> = query.split('&').collect();
    if pairs.len() > 4 {
        return Err(DeepLinkError::InvalidQuery);
    }
    for pair in pairs {
        let Some((key, value)) = pair.split_once('=') else {
            return Err(DeepLinkError::InvalidQuery);
        };
        if key.is_empty() || value.is_empty() || value.contains('=') {
            return Err(DeepLinkError::InvalidQuery);
        }
        if value.contains("..") {
            return Err(DeepLinkError::PathTraversal);
        }
        match key {
            "action" => {
                if action.is_some() {
                    return Err(DeepLinkError::InvalidQuery);
                }
                let parsed = match (is_room, value) {
                    (true, "join") => MatrixAction::Join,
                    (true, "view") => MatrixAction::View,
                    (false, "chat") => MatrixAction::Chat,
                    _ => return Err(DeepLinkError::InvalidQuery),
                };
                action = Some(parsed);
            }
            "via" if is_room => {
                if via.len() >= MAX_MATRIX_VIA_SERVERS || via.iter().any(|s| s == value) {
                    return Err(DeepLinkError::InvalidQuery);
                }
                ensure_admitted_domain(value, policy)?;
                via.push(value.to_owned());
            }
            _ => return Err(DeepLinkError::InvalidQuery),
        }
    }
    Ok((action, via))
}

fn parse_kodera_deep_link(
    rest: &str,
    policy: &DeepLinkAdmissionPolicy,
) -> Result<KoderaDeepLink, DeepLinkError> {
    let Some(after_slashes) = rest.strip_prefix("//") else {
        return Err(DeepLinkError::MalformedUri);
    };
    if after_slashes.is_empty() || after_slashes.starts_with('/') {
        return Err(DeepLinkError::MalformedUri);
    }
    let (authority_and_path, query_opt) = match after_slashes.split_once('?') {
        Some((ap, q)) => (ap, Some(q)),
        None => (after_slashes, None),
    };
    let (route_host, raw_path_opt) = match authority_and_path.split_once('/') {
        Some((host, path)) => (host, Some(path)),
        None => (authority_and_path, None),
    };
    if let Some((host_prefix, _port)) = route_host.split_once(':') {
        if matches!(host_prefix, "workspace" | "invite" | "call") {
            return Err(DeepLinkError::MalformedUri);
        }
        return Err(DeepLinkError::UntrustedOrigin);
    }
    if !matches!(route_host, "workspace" | "invite" | "call") {
        return Err(DeepLinkError::UntrustedOrigin);
    }
    let Some(raw_path) = raw_path_opt else {
        return Err(DeepLinkError::MalformedUri);
    };
    if raw_path.is_empty() {
        return Err(DeepLinkError::MalformedUri);
    }
    let segments: Vec<&str> = raw_path.split('/').collect();
    for segment in &segments {
        if *segment == "." || *segment == ".." || segment.contains("..") {
            return Err(DeepLinkError::PathTraversal);
        }
    }
    if segments.iter().any(|s| s.is_empty()) {
        return Err(DeepLinkError::MalformedUri);
    }

    let origin = parse_kodera_origin_query(query_opt, policy)?;
    let origin_suffix = origin
        .as_ref()
        .map_or_else(String::new, |domain| format!("?origin={domain}"));

    match route_host {
        "workspace" => match segments.as_slice() {
            [workspace] => {
                if !is_valid_kodera_slug(workspace) {
                    return Err(DeepLinkError::MalformedUri);
                }
                Ok(KoderaDeepLink::Workspace {
                    workspace: (*workspace).to_owned(),
                    channel: None,
                    canonical_uri: format!("kodera://workspace/{workspace}{origin_suffix}"),
                    origin,
                })
            }
            [workspace, channel] => {
                if !is_valid_kodera_slug(workspace) || !is_valid_kodera_slug(channel) {
                    return Err(DeepLinkError::MalformedUri);
                }
                Ok(KoderaDeepLink::Workspace {
                    workspace: (*workspace).to_owned(),
                    channel: Some((*channel).to_owned()),
                    canonical_uri: format!(
                        "kodera://workspace/{workspace}/{channel}{origin_suffix}"
                    ),
                    origin,
                })
            }
            _ => Err(DeepLinkError::MalformedUri),
        },
        "invite" => match segments.as_slice() {
            [invite_code] => {
                if !is_valid_invite_code(invite_code) {
                    return Err(DeepLinkError::MalformedUri);
                }
                Ok(KoderaDeepLink::Invite {
                    workspace: None,
                    invite_code: (*invite_code).to_owned(),
                    canonical_uri: format!("kodera://invite/{invite_code}{origin_suffix}"),
                    origin,
                })
            }
            [workspace, invite_code] => {
                if !is_valid_kodera_slug(workspace) || !is_valid_invite_code(invite_code) {
                    return Err(DeepLinkError::MalformedUri);
                }
                Ok(KoderaDeepLink::Invite {
                    workspace: Some((*workspace).to_owned()),
                    invite_code: (*invite_code).to_owned(),
                    canonical_uri: format!(
                        "kodera://invite/{workspace}/{invite_code}{origin_suffix}"
                    ),
                    origin,
                })
            }
            _ => Err(DeepLinkError::MalformedUri),
        },
        "call" => match segments.as_slice() {
            [room] => {
                if !is_valid_call_token(room) {
                    return Err(DeepLinkError::MalformedUri);
                }
                Ok(KoderaDeepLink::Call {
                    workspace: None,
                    room: (*room).to_owned(),
                    canonical_uri: format!("kodera://call/{room}{origin_suffix}"),
                    origin,
                })
            }
            [workspace, room] => {
                if !is_valid_kodera_slug(workspace) || !is_valid_call_token(room) {
                    return Err(DeepLinkError::MalformedUri);
                }
                Ok(KoderaDeepLink::Call {
                    workspace: Some((*workspace).to_owned()),
                    room: (*room).to_owned(),
                    canonical_uri: format!("kodera://call/{workspace}/{room}{origin_suffix}"),
                    origin,
                })
            }
            _ => Err(DeepLinkError::MalformedUri),
        },
        _ => Err(DeepLinkError::UntrustedOrigin),
    }
}

fn parse_kodera_origin_query(
    query_opt: Option<&str>,
    policy: &DeepLinkAdmissionPolicy,
) -> Result<Option<String>, DeepLinkError> {
    let Some(query) = query_opt else {
        return Ok(None);
    };
    if query.is_empty() || query.contains('&') {
        return Err(DeepLinkError::InvalidQuery);
    }
    let Some((key, value)) = query.split_once('=') else {
        return Err(DeepLinkError::InvalidQuery);
    };
    if key != "origin" || value.is_empty() || value.contains('=') {
        return Err(DeepLinkError::InvalidQuery);
    }
    if value.contains("..") {
        return Err(DeepLinkError::PathTraversal);
    }
    ensure_admitted_domain(value, policy)?;
    Ok(Some(value.to_owned()))
}

fn validate_admissible_public_domain(domain: &str) -> Result<(), DeepLinkError> {
    if domain.is_empty() || domain.contains(':') {
        return Err(DeepLinkError::MalformedUri);
    }
    if is_local_or_ip_host(domain) {
        return Err(DeepLinkError::UntrustedOrigin);
    }
    if domain.bytes().any(|b| b.is_ascii_uppercase()) {
        return Err(DeepLinkError::UntrustedOrigin);
    }
    validate_docs_host(domain).map_err(|_| DeepLinkError::MalformedUri)
}

fn ensure_admitted_domain(
    domain: &str,
    policy: &DeepLinkAdmissionPolicy,
) -> Result<(), DeepLinkError> {
    if let Some((host_without_port, port)) = domain.split_once(':') {
        if port.is_empty() || !port.bytes().all(|b| b.is_ascii_digit()) {
            return Err(DeepLinkError::MalformedUri);
        }
        if !policy.is_domain_admitted(host_without_port) {
            return Err(DeepLinkError::UntrustedOrigin);
        }
        return Err(DeepLinkError::MalformedUri);
    }
    validate_admissible_public_domain(domain)?;
    if !policy.is_domain_admitted(domain) {
        return Err(DeepLinkError::UntrustedOrigin);
    }
    Ok(())
}

fn is_local_or_ip_host(host: &str) -> bool {
    let lower = host.to_ascii_lowercase();
    if lower == "localhost"
        || lower.ends_with(".localhost")
        || lower.ends_with(".local")
        || lower.ends_with(".internal")
    {
        return true;
    }
    let parts: Vec<&str> = lower.split('.').collect();
    parts.len() == 4
        && parts.iter().all(|part| {
            !part.is_empty() && part.len() <= 3 && part.bytes().all(|b| b.is_ascii_digit())
        })
}

fn is_valid_room_alias_localpart(alias: &str) -> bool {
    (1..=64).contains(&alias.len())
        && !alias.starts_with('.')
        && !alias.ends_with('.')
        && !alias.contains("..")
        && alias.bytes().all(|b| {
            b.is_ascii_lowercase() || b.is_ascii_digit() || matches!(b, b'-' | b'_' | b'.')
        })
}

fn is_valid_room_id_localpart(room_id: &str) -> bool {
    (1..=64).contains(&room_id.len())
        && !room_id.starts_with('.')
        && !room_id.ends_with('.')
        && !room_id.contains("..")
        && room_id
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || matches!(b, b'-' | b'_' | b'.'))
}

fn is_valid_user_localpart(localpart: &str) -> bool {
    (1..=64).contains(&localpart.len())
        && !localpart.starts_with('.')
        && !localpart.ends_with('.')
        && !localpart.contains("..")
        && localpart.bytes().all(|b| {
            b.is_ascii_lowercase()
                || b.is_ascii_digit()
                || matches!(b, b'-' | b'_' | b'.' | b'=' | b'+')
        })
}

fn is_valid_kodera_slug(slug: &str) -> bool {
    (1..=64).contains(&slug.len())
        && !slug.starts_with('-')
        && !slug.ends_with('-')
        && slug
            .bytes()
            .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || matches!(b, b'-' | b'_'))
}

fn is_valid_invite_code(code: &str) -> bool {
    (6..=128).contains(&code.len())
        && !code.starts_with('-')
        && !code.ends_with('-')
        && code
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || matches!(b, b'-' | b'_'))
}

fn is_valid_call_token(token: &str) -> bool {
    (1..=64).contains(&token.len())
        && !token.starts_with('-')
        && !token.ends_with('-')
        && token
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || matches!(b, b'-' | b'_'))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn admits_canonical_matrix_room_alias_room_id_and_user_links() {
        let mut policy = DeepLinkAdmissionPolicy::kodera_default();
        policy.add_domain("chat.acme-coop.eu").unwrap();

        let alias = route_deep_link(
            "matrix:r/partner-ops:community.kodera.io?action=join",
            &policy,
        )
        .unwrap();
        assert_eq!(
            alias,
            AdmittedDeepLink::Matrix(MatrixDeepLink {
                target: MatrixTarget::RoomAlias {
                    alias: "partner-ops".to_owned(),
                    domain: "community.kodera.io".to_owned(),
                    canonical_id: "#partner-ops:community.kodera.io".to_owned(),
                },
                action: Some(MatrixAction::Join),
                via: Vec::new(),
                canonical_uri: "matrix:r/partner-ops:community.kodera.io?action=join".to_owned(),
            })
        );

        let room_id = route_deep_link(
            "matrix:roomid/AbcRoomId99_xyz:chat.acme-coop.eu?action=join&via=community.kodera.io",
            &policy,
        )
        .unwrap();
        assert_eq!(
            room_id,
            AdmittedDeepLink::Matrix(MatrixDeepLink {
                target: MatrixTarget::RoomId {
                    room_id: "AbcRoomId99_xyz".to_owned(),
                    domain: "chat.acme-coop.eu".to_owned(),
                    canonical_id: "!AbcRoomId99_xyz:chat.acme-coop.eu".to_owned(),
                },
                action: Some(MatrixAction::Join),
                via: vec!["community.kodera.io".to_owned()],
                canonical_uri:
                    "matrix:roomid/AbcRoomId99_xyz:chat.acme-coop.eu?action=join&via=community.kodera.io"
                        .to_owned(),
            })
        );

        let user = route_deep_link("matrix:u/zxxma:kodera.io?action=chat", &policy).unwrap();
        assert_eq!(
            user,
            AdmittedDeepLink::Matrix(MatrixDeepLink {
                target: MatrixTarget::User {
                    localpart: "zxxma".to_owned(),
                    domain: "kodera.io".to_owned(),
                    canonical_id: "@zxxma:kodera.io".to_owned(),
                },
                action: Some(MatrixAction::Chat),
                via: Vec::new(),
                canonical_uri: "matrix:u/zxxma:kodera.io?action=chat".to_owned(),
            })
        );
    }

    #[test]
    fn admits_canonical_kodera_workspace_invite_and_call_links() {
        let mut policy = DeepLinkAdmissionPolicy::kodera_default();
        policy.add_domain("chat.acme-coop.eu").unwrap();

        let ws = route_deep_link("kodera://workspace/acme-coop/general", &policy).unwrap();
        assert_eq!(
            ws,
            AdmittedDeepLink::Kodera(KoderaDeepLink::Workspace {
                workspace: "acme-coop".to_owned(),
                channel: Some("general".to_owned()),
                origin: None,
                canonical_uri: "kodera://workspace/acme-coop/general".to_owned(),
            })
        );

        let invite = route_deep_link(
            "kodera://invite/acme-coop/inv_9f8e7d6c5b4a?origin=chat.acme-coop.eu",
            &policy,
        )
        .unwrap();
        assert_eq!(
            invite,
            AdmittedDeepLink::Kodera(KoderaDeepLink::Invite {
                workspace: Some("acme-coop".to_owned()),
                invite_code: "inv_9f8e7d6c5b4a".to_owned(),
                origin: Some("chat.acme-coop.eu".to_owned()),
                canonical_uri:
                    "kodera://invite/acme-coop/inv_9f8e7d6c5b4a?origin=chat.acme-coop.eu".to_owned(),
            })
        );

        let call = route_deep_link("kodera://call/acme-coop/daily-standup", &policy).unwrap();
        assert_eq!(
            call,
            AdmittedDeepLink::Kodera(KoderaDeepLink::Call {
                workspace: Some("acme-coop".to_owned()),
                room: "daily-standup".to_owned(),
                origin: None,
                canonical_uri: "kodera://call/acme-coop/daily-standup".to_owned(),
            })
        );
    }

    #[test]
    fn rejects_dangerous_and_unsupported_schemes() {
        let policy = DeepLinkAdmissionPolicy::kodera_default();
        for bad in [
            "javascript:alert(1)",
            "JavaScript:fetch('https://evil.example.org')",
            "data:text/html,<script>alert(1)</script>",
            "file:///etc/passwd",
            "http://kodera.io/workspace/acme",
            "https://kodera.io/workspace/acme",
            "ws://kodera.io/socket",
            "KODERA://workspace/acme",
            "MATRIX:r/general:kodera.io",
        ] {
            assert_eq!(
                route_deep_link(bad, &policy),
                Err(DeepLinkError::UnsupportedScheme),
                "expected UnsupportedScheme for {bad}"
            );
        }
    }

    #[test]
    fn rejects_path_traversal_credentials_controls_and_oversized_payloads() {
        let policy = DeepLinkAdmissionPolicy::kodera_default();
        for traversal in [
            "kodera://workspace/../admin",
            "kodera://workspace/acme/..",
            "kodera://workspace/%2e%2e/secret",
            "kodera://workspace/acme%2f..%2froot",
            "kodera://workspace\\..\\admin",
            "matrix:r/../ops:community.kodera.io",
            "matrix:r/ops..room:community.kodera.io",
            "matrix:r/ops:community.kodera.io?via=..evil.org",
        ] {
            assert_eq!(
                route_deep_link(traversal, &policy),
                Err(DeepLinkError::PathTraversal),
                "expected PathTraversal for {traversal}"
            );
        }

        for creds in [
            "kodera://admin:secret@workspace/acme",
            "kodera://user@workspace/acme",
            "kodera://workspace/acme%40evil.org",
            "matrix:u/alice:secret@community.kodera.io",
            "matrix:u/@alice:community.kodera.io",
        ] {
            assert_eq!(
                route_deep_link(creds, &policy),
                Err(DeepLinkError::EmbeddedCredentials),
                "expected EmbeddedCredentials for {creds}"
            );
        }

        for control in [
            "kodera://workspace/acme\0root",
            "kodera://workspace/acme\r\nHost:evil",
            "kodera://workspace/acme\troom",
            "matrix:r/ops:community.kodera.io\x7f",
            "kodera://workspace/acme%00",
            "kodera://workspace/acme%0a",
        ] {
            assert_eq!(
                route_deep_link(control, &policy),
                Err(DeepLinkError::ControlCharacter),
                "expected ControlCharacter for {control:?}"
            );
        }

        assert_eq!(route_deep_link("", &policy), Err(DeepLinkError::EmptyUri));
        let oversized = format!("kodera://workspace/{}", "a".repeat(MAX_DEEP_LINK_BYTES));
        assert_eq!(
            route_deep_link(&oversized, &policy),
            Err(DeepLinkError::PayloadTooLarge)
        );
    }

    #[test]
    fn rejects_non_admitted_origins_and_malformed_links_without_echoing_input() {
        let policy = DeepLinkAdmissionPolicy::kodera_default();
        for untrusted in [
            "matrix:r/ops:untrusted.example.org?action=join",
            "matrix:r/ops:localhost?action=join",
            "matrix:r/ops:127.0.0.1?action=join",
            "matrix:r/ops:KODERA.IO?action=join",
            "matrix:r/ops:community.kodera.io?action=join&via=rogue.example.org",
            "kodera://evil.example.org/workspace/acme",
            "kodera://admin/panel",
            "kodera://workspace/acme?origin=untrusted.example.org",
            "kodera://workspace/acme?origin=169.254.169.254",
        ] {
            let err = route_deep_link(untrusted, &policy).unwrap_err();
            assert_eq!(
                err,
                DeepLinkError::UntrustedOrigin,
                "expected UntrustedOrigin for {untrusted}"
            );
            assert_eq!(err.to_string(), "untrusted_origin");
            assert!(!err.to_string().contains("example.org"));
        }

        for malformed in [
            "not-a-uri",
            "kodera:workspace/acme",
            "kodera:///workspace/acme",
            "kodera://workspace/",
            "kodera://workspace:8080/acme",
            "kodera://workspace/acme#frag",
            "kodera://invite/short",
            "matrix://community.kodera.io/r/ops",
            "matrix:r/ops",
            "matrix:r/ops:community.kodera.io:8448",
            "matrix:x/ops:community.kodera.io",
        ] {
            assert_eq!(
                route_deep_link(malformed, &policy),
                Err(DeepLinkError::MalformedUri),
                "expected MalformedUri for {malformed}"
            );
        }

        for bad_query in [
            "matrix:r/ops:community.kodera.io?",
            "matrix:r/ops:community.kodera.io?action=exec",
            "matrix:u/alice:community.kodera.io?action=join",
            "matrix:r/ops:community.kodera.io?action=join&action=join",
            "kodera://workspace/acme?redirect=https://evil.test",
            "kodera://workspace/acme?",
        ] {
            assert_eq!(
                route_deep_link(bad_query, &policy),
                Err(DeepLinkError::InvalidQuery),
                "expected InvalidQuery for {bad_query}"
            );
        }
    }
}
