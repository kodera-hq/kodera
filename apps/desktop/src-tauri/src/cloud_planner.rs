//! Local-only 1-click self-host provider specification validator and public deployment planner.

use core::fmt;
use std::collections::BTreeMap;
use zeroize::{Zeroize, Zeroizing};

#[cfg(test)]
mod tests;

/// Supported 1-click self-host VPS providers executed locally from Kodera Desktop.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum CloudProvider {
    Scaleway,
    Hetzner,
    Hostinger,
    OvhCloud,
}

impl CloudProvider {
    pub fn slug(self) -> &'static str {
        match self {
            Self::Scaleway => "scaleway",
            Self::Hetzner => "hetzner",
            Self::Hostinger => "hostinger",
            Self::OvhCloud => "ovhcloud",
        }
    }

    pub fn api_origin(self) -> &'static str {
        match self {
            Self::Scaleway => "https://api.scaleway.com",
            Self::Hetzner => "https://api.hetzner.cloud",
            Self::Hostinger => "https://developers.hostinger.com",
            Self::OvhCloud => "https://eu.api.ovh.com",
        }
    }
}

/// Ephemeral provider API token wrapper whose `Debug` and `Display` implementations
/// unconditionally redact the underlying secret material and whose backing bytes are
/// zeroized on construction, rejection, explicit clear, and drop (`!Clone`).
pub struct RedactedApiToken(Zeroizing<Vec<u8>>);

impl RedactedApiToken {
    pub fn new(raw: impl Into<String>) -> Result<Self, DeployValidationError> {
        let mut owned = Zeroizing::new(raw.into().into_bytes());
        Self::validate_and_zeroize_slice(&mut owned)
    }

    /// Validates `buf` as a visible-ASCII API token, copies trimmed validated bytes into a
    /// `Zeroizing<Vec<u8>>`, and unconditionally overwrites `buf` with zeros on both success
    /// and validation error.
    pub fn validate_and_zeroize_slice(buf: &mut [u8]) -> Result<Self, DeployValidationError> {
        let result = (|| {
            let Ok(s) = core::str::from_utf8(buf) else {
                return Err(DeployValidationError::TokenInvalidCharacters);
            };
            let trimmed = s.trim();
            if trimmed.len() < 16 {
                return Err(DeployValidationError::TokenTooShort);
            }
            if trimmed.len() > 512 {
                return Err(DeployValidationError::TokenInvalidCharacters);
            }
            if trimmed.chars().any(char::is_whitespace) {
                return Err(DeployValidationError::TokenContainsWhitespace);
            }
            if !trimmed.bytes().all(|b| (0x21..=0x7E).contains(&b)) {
                return Err(DeployValidationError::TokenInvalidCharacters);
            }
            Ok(Self(Zeroizing::new(trimmed.as_bytes().to_vec())))
        })();
        buf.zeroize();
        result
    }

    /// Overwrites the backing token buffer with zeros in place and clears its length.
    pub fn clear(&mut self) {
        self.0.zeroize();
        self.0.clear();
    }

    /// Exposes the raw token strictly for outbound HTTPS `Authorization` headers to `provider.api_origin()`.
    pub fn expose_for_provider_call(&self) -> &str {
        core::str::from_utf8(&self.0).expect("validated visible ASCII token")
    }
}

impl fmt::Debug for RedactedApiToken {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str("RedactedApiToken([REDACTED])")
    }
}

impl fmt::Display for RedactedApiToken {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str("[REDACTED]")
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum DeployValidationError {
    InvalidDomain,
    InvalidAdminEmail,
    InvalidRegion,
    TokenTooShort,
    TokenContainsWhitespace,
    TokenInvalidCharacters,
}

/// Validated specification for deploying `deploy/community` onto a user-owned VPS.
#[derive(Debug)]
pub struct SelfHostDeploymentSpec {
    pub provider: CloudProvider,
    pub region: String,
    pub fqdn: String,
    pub acme_email: String,
    pub token: RedactedApiToken,
}

impl SelfHostDeploymentSpec {
    pub fn validate(
        provider: CloudProvider,
        region: &str,
        fqdn: &str,
        acme_email: &str,
        raw_token: impl Into<String>,
    ) -> Result<Self, DeployValidationError> {
        let mut owned_token = Zeroizing::new(raw_token.into().into_bytes());
        let public_fields = Self::validate_public_fields(region, fqdn, acme_email);
        let token_res = RedactedApiToken::validate_and_zeroize_slice(&mut owned_token);
        let (region_norm, fqdn_norm, email_norm) = public_fields?;
        let token = token_res?;
        Ok(Self {
            provider,
            region: region_norm,
            fqdn: fqdn_norm,
            acme_email: email_norm,
            token,
        })
    }

    pub fn from_validated_token(
        provider: CloudProvider,
        region: &str,
        fqdn: &str,
        acme_email: &str,
        token: RedactedApiToken,
    ) -> Result<Self, DeployValidationError> {
        let (region_norm, fqdn_norm, email_norm) =
            Self::validate_public_fields(region, fqdn, acme_email)?;
        Ok(Self {
            provider,
            region: region_norm,
            fqdn: fqdn_norm,
            acme_email: email_norm,
            token,
        })
    }

    pub(crate) fn validate_public_fields(
        region: &str,
        fqdn: &str,
        acme_email: &str,
    ) -> Result<(String, String, String), DeployValidationError> {
        let fqdn_norm = fqdn.trim().to_ascii_lowercase();
        if !is_valid_public_fqdn(&fqdn_norm) {
            return Err(DeployValidationError::InvalidDomain);
        }
        let email_norm = acme_email.trim();
        if !is_valid_email(email_norm) {
            return Err(DeployValidationError::InvalidAdminEmail);
        }
        let region_norm = region.trim();
        if region_norm.is_empty()
            || region_norm.len() > 32
            || !region_norm
                .chars()
                .all(|c| c.is_ascii_alphanumeric() || c == '-')
        {
            return Err(DeployValidationError::InvalidRegion);
        }
        Ok((region_norm.to_owned(), fqdn_norm, email_norm.to_owned()))
    }
}

/// Public DNS requirement awaiting the future provider adapter's allocated server addresses.
/// It is not a configured record, an invented IP address, or a claim that a service is running.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PublicDnsRequirement {
    pub fqdn: String,
    pub target: PublicDnsTarget,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum PublicDnsTarget {
    AllocatedServerPublicAddresses,
}

/// Deterministic, non-executable public plan. Contains no token or deployment secret.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SelfHostDeploymentPlan {
    pub provider: CloudProvider,
    pub region: String,
    pub required_dns: Vec<PublicDnsRequirement>,
    pub https_origins: Vec<String>,
    /// Only the actual public keys consumed by deploy/community; secrets must be generated later.
    pub community_public_config: BTreeMap<String, String>,
}

impl SelfHostDeploymentPlan {
    pub fn from_spec(spec: &SelfHostDeploymentSpec) -> Result<Self, DeployValidationError> {
        // Spec fields are public, so callers can mutate a previously validated value.
        let (region, fqdn, acme_email) = SelfHostDeploymentSpec::validate_public_fields(
            &spec.region,
            &spec.fqdn,
            &spec.acme_email,
        )?;
        let names =
            ["", "matrix.", "visio.", "docs.", "auth."].map(|prefix| format!("{prefix}{fqdn}"));
        if names.iter().any(|name| !is_valid_public_fqdn(name)) {
            return Err(DeployValidationError::InvalidDomain);
        }
        Ok(Self {
            provider: spec.provider,
            region,
            required_dns: names
                .iter()
                .map(|name| PublicDnsRequirement {
                    fqdn: name.clone(),
                    target: PublicDnsTarget::AllocatedServerPublicAddresses,
                })
                .collect(),
            https_origins: names.iter().map(|name| format!("https://{name}")).collect(),
            community_public_config: BTreeMap::from([
                ("KODERA_DOMAIN".to_owned(), fqdn),
                ("KODERA_ACME_EMAIL".to_owned(), acme_email),
            ]),
        })
    }
}

fn is_valid_public_fqdn(fqdn: &str) -> bool {
    if fqdn.len() < 4 || fqdn.len() > 253 || fqdn.starts_with('.') || fqdn.ends_with('.') {
        return false;
    }
    if fqdn == "localhost" || fqdn.ends_with(".local") || fqdn.ends_with(".internal") {
        return false;
    }
    let labels: Vec<&str> = fqdn.split('.').collect();
    if labels.len() < 2 {
        return false;
    }
    // Reject raw IPv4 literals (e.g. 127.0.0.1, 169.254.169.254) by requiring an alphabetic TLD >= 2 chars.
    let Some(&tld) = labels.last() else {
        return false;
    };
    if tld.len() < 2 || tld.len() > 63 || !tld.bytes().all(|b| b.is_ascii_alphabetic()) {
        return false;
    }
    labels.iter().all(|label| {
        !label.is_empty()
            && label.len() <= 63
            && !label.starts_with('-')
            && !label.ends_with('-')
            && label.chars().all(|c| c.is_ascii_alphanumeric() || c == '-')
    })
}

fn is_valid_email(email: &str) -> bool {
    let Some((local, domain)) = email.split_once('@') else {
        return false;
    };
    !local.is_empty()
        && local.len() <= 64
        && !local.starts_with('.')
        && !local.ends_with('.')
        && !local.contains("..")
        && local
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || matches!(b, b'.' | b'_' | b'%' | b'+' | b'-'))
        && is_valid_public_fqdn(&domain.to_ascii_lowercase())
}

/// Local input validation only. It makes no provider request or deployment.
pub fn preflight_self_host_spec(
    provider: CloudProvider,
    region: &str,
    fqdn: &str,
    acme_email: &str,
    raw_token: &str,
) -> Result<SelfHostDeploymentSpec, DeployValidationError> {
    SelfHostDeploymentSpec::validate(provider, region, fqdn, acme_email, raw_token)
}
