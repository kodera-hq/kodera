//! WebView URL navigation security guard and canonical asset path normalizer.

use super::{
    APPROVED_AUTH_ORIGIN_PREFIX, APPROVED_DEV_ORIGINS, APPROVED_WEB_APP_ORIGINS,
    CUSTOM_ASSET_SCHEME, DANGEROUS_SCHEMES, MAX_NAVIGATION_URL_BYTES,
};
use crate::{route_deep_link, AdmittedDeepLink, DeepLinkAdmissionPolicy, DeepLinkError};
use core::fmt;

/// Closed refusal codes for the WebView navigation security guard.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum NavigationGuardError {
    EmptyUrl,
    UrlTooLarge,
    ControlOrWhitespace,
    DangerousScheme,
    UnsupportedScheme,
    EmbeddedCredentials,
    PathTraversal,
    UntrustedOrigin,
    RejectedDeepLink(DeepLinkError),
}

impl fmt::Display for NavigationGuardError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::EmptyUrl => f.write_str("empty_url"),
            Self::UrlTooLarge => f.write_str("url_too_large"),
            Self::ControlOrWhitespace => f.write_str("control_or_whitespace"),
            Self::DangerousScheme => f.write_str("dangerous_scheme"),
            Self::UnsupportedScheme => f.write_str("unsupported_scheme"),
            Self::EmbeddedCredentials => f.write_str("embedded_credentials"),
            Self::PathTraversal => f.write_str("path_traversal"),
            Self::UntrustedOrigin => f.write_str("untrusted_origin"),
            Self::RejectedDeepLink(err) => write!(f, "rejected_deep_link:{err}"),
        }
    }
}

impl std::error::Error for NavigationGuardError {}

/// Policy outcome for a candidate WebView navigation URL.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum NavigationDecision {
    /// Internal bundled/bootstrap asset on `kodera-asset://localhost/...`.
    AllowInternalAsset { normalized_path: String },
    /// Approved Kodera Web HTTPS origin (or explicit local Vite dev origin in dev mode).
    AllowTrustedWebOrigin { origin: String },
    /// Validated `kodera://` or `matrix:` URI intercepted for in-app routing instead of navigation.
    InterceptDeepLink(AdmittedDeepLink),
}

/// Validates any URL before loading it into the native WebView, admitting navigation, or accepting
/// an IPC message from its frame. Fails closed on unknown schemes, untrusted origins, credentials,
/// and traversal sequences.
pub fn validate_navigation_url(
    raw_url: &str,
    policy: &DeepLinkAdmissionPolicy,
    allow_dev_origin: bool,
) -> Result<NavigationDecision, NavigationGuardError> {
    validate_navigation_url_for_os(
        raw_url,
        policy,
        allow_dev_origin,
        cfg!(target_os = "windows"),
    )
}

/// Platform-parameterized navigation and IPC origin validator (`is_windows = true` trusts
/// `https://kodera-asset.localhost` matching `with_https_scheme(true)`; `is_windows = false`
/// trusts `kodera-asset://localhost`; cleartext `http://kodera-asset.localhost` is rejected on
/// every OS).
pub fn validate_navigation_url_for_os(
    raw_url: &str,
    policy: &DeepLinkAdmissionPolicy,
    allow_dev_origin: bool,
    is_windows: bool,
) -> Result<NavigationDecision, NavigationGuardError> {
    if raw_url.is_empty() {
        return Err(NavigationGuardError::EmptyUrl);
    }
    if raw_url.len() > MAX_NAVIGATION_URL_BYTES {
        return Err(NavigationGuardError::UrlTooLarge);
    }
    if raw_url
        .bytes()
        .any(|b| b <= 0x20 || b >= 0x7F || b == b'\\')
    {
        return Err(NavigationGuardError::ControlOrWhitespace);
    }
    if contains_control_percent_escape(raw_url) {
        return Err(NavigationGuardError::PathTraversal);
    }

    let Some((scheme_raw, _after_colon)) = raw_url.split_once(':') else {
        return Err(NavigationGuardError::UnsupportedScheme);
    };
    if scheme_raw.is_empty() {
        return Err(NavigationGuardError::UnsupportedScheme);
    }
    let scheme_lower = scheme_raw.to_ascii_lowercase();
    if DANGEROUS_SCHEMES.contains(&scheme_lower.as_str()) {
        return Err(NavigationGuardError::DangerousScheme);
    }

    if scheme_lower == "kodera" || scheme_lower == "matrix" {
        if scheme_raw != scheme_lower {
            return Err(NavigationGuardError::UnsupportedScheme);
        }
        return route_deep_link(raw_url, policy)
            .map(NavigationDecision::InterceptDeepLink)
            .map_err(NavigationGuardError::RejectedDeepLink);
    }

    let before_query_or_fragment = raw_url.split(['?', '#']).next().unwrap_or(raw_url);
    if contains_forbidden_percent_escape(before_query_or_fragment) {
        return Err(NavigationGuardError::PathTraversal);
    }

    if scheme_lower == CUSTOM_ASSET_SCHEME {
        if is_windows {
            return Err(NavigationGuardError::UntrustedOrigin);
        }
        let Some(rest) = raw_url
            .get(CUSTOM_ASSET_SCHEME.len()..)
            .and_then(|s| s.strip_prefix("://"))
        else {
            return Err(NavigationGuardError::UntrustedOrigin);
        };
        return validate_internal_asset_authority_and_path(rest);
    }

    if scheme_lower == "https" || scheme_lower == "http" {
        let prefix_len = scheme_raw.len() + 3;
        if !raw_url[scheme_raw.len()..].starts_with("://") {
            return Err(NavigationGuardError::UnsupportedScheme);
        }
        let after_slashes = &raw_url[prefix_len..];
        let (authority, path_and_more) = split_authority_and_tail(after_slashes);
        if authority.is_empty() {
            return Err(NavigationGuardError::UntrustedOrigin);
        }
        if authority.contains('@') {
            return Err(NavigationGuardError::EmbeddedCredentials);
        }
        let authority_lower = authority.to_ascii_lowercase();

        // Windows WebView2 with `with_https_scheme(true)` maps bundled custom protocol assets
        // strictly onto `https://kodera-asset.localhost/...`. Cleartext `http://kodera-asset.localhost`
        // is rejected on every OS, and `https://kodera-asset.localhost` is rejected on Unix.
        if authority_lower == "kodera-asset.localhost" {
            if is_windows && scheme_lower == "https" {
                let normalized_path = normalize_asset_path(path_and_more)?;
                return Ok(NavigationDecision::AllowInternalAsset { normalized_path });
            }
            return Err(NavigationGuardError::UntrustedOrigin);
        }

        validate_url_path_segments(path_and_more)?;

        if scheme_lower == "https" {
            let candidate_origin = format!("https://{authority_lower}");
            if APPROVED_WEB_APP_ORIGINS.contains(&candidate_origin.as_str()) {
                return Ok(NavigationDecision::AllowTrustedWebOrigin {
                    origin: candidate_origin,
                });
            }
            let normalized_full = format!("https://{authority_lower}{path_and_more}");
            if normalized_full.starts_with(APPROVED_AUTH_ORIGIN_PREFIX) {
                return Ok(NavigationDecision::AllowTrustedWebOrigin {
                    origin: "https://auth.kodera.io".to_owned(),
                });
            }
            return Err(NavigationGuardError::UntrustedOrigin);
        }

        // Cleartext `http:` is unconditionally rejected unless explicit local dev mode is active.
        if allow_dev_origin {
            let candidate_origin = format!("http://{authority_lower}");
            if APPROVED_DEV_ORIGINS.contains(&candidate_origin.as_str()) {
                return Ok(NavigationDecision::AllowTrustedWebOrigin {
                    origin: candidate_origin,
                });
            }
        }
        return Err(NavigationGuardError::UntrustedOrigin);
    }

    Err(NavigationGuardError::UnsupportedScheme)
}

fn validate_internal_asset_authority_and_path(
    rest: &str,
) -> Result<NavigationDecision, NavigationGuardError> {
    let (authority, tail) = split_authority_and_tail(rest);
    if authority.contains('@') {
        return Err(NavigationGuardError::EmbeddedCredentials);
    }
    if !authority.eq_ignore_ascii_case("localhost") {
        return Err(NavigationGuardError::UntrustedOrigin);
    }
    let normalized_path = normalize_asset_path(tail)?;
    Ok(NavigationDecision::AllowInternalAsset { normalized_path })
}

fn split_authority_and_tail(input: &str) -> (&str, &str) {
    let split_idx = input.find(['/', '?', '#']).unwrap_or(input.len());
    (&input[..split_idx], &input[split_idx..])
}

fn validate_url_path_segments(tail: &str) -> Result<(), NavigationGuardError> {
    let path_only = tail.split(['?', '#']).next().unwrap_or("");
    for seg in path_only.split('/') {
        if seg == ".." {
            return Err(NavigationGuardError::PathTraversal);
        }
    }
    Ok(())
}

pub(super) fn normalize_asset_path(tail: &str) -> Result<String, NavigationGuardError> {
    let path_only = tail.split(['?', '#']).next().unwrap_or("");
    if path_only.is_empty() || path_only == "/" {
        return Ok("/index.html".to_owned());
    }
    if !path_only.starts_with('/') {
        return Err(NavigationGuardError::UntrustedOrigin);
    }
    let mut segments = Vec::new();
    for seg in path_only.split('/').skip(1) {
        if seg.is_empty() || seg == "." {
            return Err(NavigationGuardError::PathTraversal);
        }
        if seg == ".." {
            return Err(NavigationGuardError::PathTraversal);
        }
        if !seg
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || matches!(b, b'-' | b'_' | b'.' | b'@'))
        {
            return Err(NavigationGuardError::PathTraversal);
        }
        segments.push(seg);
    }
    Ok(format!("/{}", segments.join("/")))
}

fn contains_control_percent_escape(raw: &str) -> bool {
    let bytes = raw.as_bytes();
    let mut idx = 0;
    while idx + 2 < bytes.len() {
        if bytes[idx] == b'%' {
            let hi = bytes[idx + 1].to_ascii_lowercase();
            let lo = bytes[idx + 2].to_ascii_lowercase();
            if (matches!(hi, b'0' | b'1') && lo.is_ascii_hexdigit()) || [hi, lo] == *b"7f" {
                return true;
            }
        }
        idx += 1;
    }
    false
}

fn contains_forbidden_percent_escape(raw: &str) -> bool {
    let bytes = raw.as_bytes();
    let mut idx = 0;
    while idx + 2 < bytes.len() {
        if bytes[idx] == b'%' {
            let hi = bytes[idx + 1].to_ascii_lowercase();
            let lo = bytes[idx + 2].to_ascii_lowercase();
            let pair = [hi, lo];
            // Control bytes %00-%1f, %7f, dot %2e, slash %2f, backslash %5c.
            if matches!(hi, b'0' | b'1') && lo.is_ascii_hexdigit() {
                return true;
            }
            if pair == *b"7f" || pair == *b"2e" || pair == *b"2f" || pair == *b"5c" {
                return true;
            }
        }
        idx += 1;
    }
    false
}
