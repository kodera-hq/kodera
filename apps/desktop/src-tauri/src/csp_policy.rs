//! Compile-time and runtime Tauri v2 Content Security Policy (`CSP`) invariant verifier.
//!
//! Security invariants (`WEB-ADR-0012` + Desktop WebView hardening):
//! - `default-src` MUST be strictly `'self'` (script execution falls back here; no `script-src`
//!   expansion, zero `'unsafe-eval'`, zero `'unsafe-inline'` scripts).
//! - `connect-src` MUST admit only `'self'` plus explicit path-scoped `https://` and `wss://`
//!   origins (`https://api.kodera.io/api/v1/`, `https://auth.kodera.io/realms/`,
//!   `https://*.kodera.io/.well-known/matrix/client`, `https://*.kodera.io/_matrix/`,
//!   `https://*.kodera.io/_kodera/rooms/token`, `wss://*.kodera.io/rtc*`,
//!   `wss://*.kodera.io/ws/collab/`). Bare wildcards (`*`, `https:`, `wss:`, `https://*.kodera.io`)
//!   and cleartext schemes (`http:`, `ws:`) fail closed.
//! - `object-src`, `base-uri`, and `frame-ancestors` MUST all be `'none'`.

use core::fmt;
use std::collections::{BTreeMap, BTreeSet};

/// Approved `connect-src` tokens in `apps/desktop/src-tauri/tauri.conf.json`.
pub const APPROVED_CONNECT_SOURCES: [&str; 11] = [
    "'self'",
    "https://api.kodera.io/api/v1/",
    "https://auth.kodera.io/realms/",
    "https://*.kodera.io/.well-known/matrix/client",
    "https://*.kodera.io/_matrix/",
    "https://*.kodera.io/_kodera/rooms/token",
    "wss://*.kodera.io/rtc",
    "wss://*.kodera.io/rtc/v1",
    "wss://*.kodera.io/rtc/validate",
    "wss://*.kodera.io/rtc/v1/validate",
    "wss://*.kodera.io/ws/collab/",
];

/// Closed refusal codes for desktop CSP validation.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum CspPolicyError {
    EmptyPolicy,
    UnsafeEvalPresent,
    DuplicateDirective,
    UnapprovedDirective,
    MissingRequiredDirective,
    InvalidDirectiveSources,
    UnapprovedConnectOrigin,
}

impl fmt::Display for CspPolicyError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        let code = match self {
            Self::EmptyPolicy => "empty_policy",
            Self::UnsafeEvalPresent => "unsafe_eval_present",
            Self::DuplicateDirective => "duplicate_directive",
            Self::UnapprovedDirective => "unapproved_directive",
            Self::MissingRequiredDirective => "missing_required_directive",
            Self::InvalidDirectiveSources => "invalid_directive_sources",
            Self::UnapprovedConnectOrigin => "unapproved_connect_origin",
        };
        f.write_str(code)
    }
}

impl std::error::Error for CspPolicyError {}

/// Validates a raw Content Security Policy header/config string against Kodera Desktop's
/// strict Tauri v2 WebView policy.
pub fn verify_desktop_csp(raw_csp: &str) -> Result<(), CspPolicyError> {
    let trimmed = raw_csp.trim();
    if trimmed.is_empty() {
        return Err(CspPolicyError::EmptyPolicy);
    }
    if trimmed.to_ascii_lowercase().contains("unsafe-eval") {
        return Err(CspPolicyError::UnsafeEvalPresent);
    }

    let mut directives: BTreeMap<String, Vec<String>> = BTreeMap::new();
    for segment in trimmed.split(';') {
        let part = segment.trim();
        if part.is_empty() {
            continue;
        }
        let mut tokens = part.split_whitespace();
        let Some(name) = tokens.next() else {
            continue;
        };
        let sources: Vec<String> = tokens.map(str::to_owned).collect();
        if sources.is_empty() {
            return Err(CspPolicyError::InvalidDirectiveSources);
        }
        if directives.insert(name.to_owned(), sources).is_some() {
            return Err(CspPolicyError::DuplicateDirective);
        }
    }

    let expected_exact: [(&str, &[&str]); 11] = [
        ("default-src", &["'self'"]),
        ("img-src", &["'self'", "data:", "blob:"]),
        ("media-src", &["'self'", "blob:"]),
        ("worker-src", &["'self'", "blob:"]),
        ("style-src", &["'self'"]),
        ("style-src-attr", &["'unsafe-inline'"]),
        ("font-src", &["'self'", "data:"]),
        ("object-src", &["'none'"]),
        ("base-uri", &["'none'"]),
        ("form-action", &["'self'"]),
        ("frame-ancestors", &["'none'"]),
    ];

    if directives.len() != expected_exact.len() + 1 {
        let known: BTreeSet<&str> = expected_exact
            .iter()
            .map(|(k, _)| *k)
            .chain(core::iter::once("connect-src"))
            .collect();
        for key in directives.keys() {
            if !known.contains(key.as_str()) {
                return Err(CspPolicyError::UnapprovedDirective);
            }
        }
        return Err(CspPolicyError::MissingRequiredDirective);
    }

    for (name, expected_sources) in expected_exact {
        let Some(actual) = directives.get(name) else {
            return Err(CspPolicyError::MissingRequiredDirective);
        };
        let actual_set: BTreeSet<&str> = actual.iter().map(String::as_str).collect();
        let expected_set: BTreeSet<&str> = expected_sources.iter().copied().collect();
        if actual.len() != actual_set.len() || actual_set != expected_set {
            return Err(CspPolicyError::InvalidDirectiveSources);
        }
    }

    let Some(connect_sources) = directives.get("connect-src") else {
        return Err(CspPolicyError::MissingRequiredDirective);
    };
    let connect_set: BTreeSet<&str> = connect_sources.iter().map(String::as_str).collect();
    let approved_set: BTreeSet<&str> = APPROVED_CONNECT_SOURCES.iter().copied().collect();
    if connect_sources.len() != connect_set.len() || connect_set != approved_set {
        return Err(CspPolicyError::UnapprovedConnectOrigin);
    }

    for source in &connect_set {
        if *source != "'self'" && !is_explicit_path_scoped_secure_origin(source) {
            return Err(CspPolicyError::UnapprovedConnectOrigin);
        }
    }

    Ok(())
}

fn is_explicit_path_scoped_secure_origin(source: &str) -> bool {
    let rest = if let Some(r) = source.strip_prefix("https://") {
        r
    } else if let Some(r) = source.strip_prefix("wss://") {
        r
    } else {
        return false;
    };
    let Some((host, path)) = rest.split_once('/') else {
        // Bare host without path scope (e.g. `https://*.kodera.io`) is forbidden per WEB-ADR-0012.
        return false;
    };
    !host.is_empty() && !path.is_empty() && (host.ends_with(".kodera.io") || host == "kodera.io")
}

/// Extracts and verifies the embedded `tauri.conf.json` CSP at runtime / self-check time.
pub fn verify_embedded_tauri_conf_csp() -> Result<String, CspPolicyError> {
    const TAURI_CONF: &str = include_str!("../tauri.conf.json");
    let marker = "\"csp\":";
    let Some(idx) = TAURI_CONF.find(marker) else {
        return Err(CspPolicyError::EmptyPolicy);
    };
    let after = TAURI_CONF[idx + marker.len()..].trim_start();
    let Some(rest) = after.strip_prefix('"') else {
        return Err(CspPolicyError::EmptyPolicy);
    };
    let Some(end_quote) = rest.find('"') else {
        return Err(CspPolicyError::EmptyPolicy);
    };
    let csp = &rest[..end_quote];
    verify_desktop_csp(csp)?;
    Ok(csp.to_owned())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn verifies_embedded_tauri_conf_csp_and_rejects_unsafe_mutations() {
        let embedded = verify_embedded_tauri_conf_csp().unwrap();
        assert!(embedded.contains("default-src 'self'"));
        assert!(!embedded.contains("unsafe-eval"));

        // Injecting unsafe-eval anywhere fails closed.
        let with_eval = format!("{embedded}; script-src 'self' 'unsafe-eval'");
        assert_eq!(
            verify_desktop_csp(&with_eval),
            Err(CspPolicyError::UnsafeEvalPresent)
        );

        // Adding script-src without unsafe-eval still fails closed as an unapproved directive.
        let extra_script = format!("{embedded}; script-src 'self' https://cdn.example.org");
        assert_eq!(
            verify_desktop_csp(&extra_script),
            Err(CspPolicyError::UnapprovedDirective)
        );

        // Bare wildcard or cleartext connect-src fails closed.
        let bare_wildcard = embedded.replace("https://*.kodera.io/_matrix/", "https://*.kodera.io");
        assert_eq!(
            verify_desktop_csp(&bare_wildcard),
            Err(CspPolicyError::UnapprovedConnectOrigin)
        );

        let cleartext = embedded.replace(
            "https://api.kodera.io/api/v1/",
            "http://api.kodera.io/api/v1/",
        );
        assert_eq!(
            verify_desktop_csp(&cleartext),
            Err(CspPolicyError::UnapprovedConnectOrigin)
        );

        // Weakening default-src fails closed.
        let weak_default = embedded.replace("default-src 'self'", "default-src *");
        assert_eq!(
            verify_desktop_csp(&weak_default),
            Err(CspPolicyError::InvalidDirectiveSources)
        );
    }
}
