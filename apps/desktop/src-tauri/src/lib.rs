//! Kodera Desktop (`apps/desktop/src-tauri`)
//!
//! Native Rust runtime backing the Tauri v2 desktop application:
//! 1. Links [`kodera_rs`] for unified device identity, MLS session envelopes, and `#proximity`
//!    offline BLE/Wi-Fi frame validation. The channel was first named `#urgence`; its frozen v1
//!    wire bytes and its legacy JSON route names are unchanged.
//! 2. Implements the **local-only 1-Click Self-Host Deployer** specification validator for
//!    European and global cloud providers (Scaleway, Hetzner, Hostinger, OVHcloud).
//!
//! Security invariant: provider API tokens supplied by an administrator during 1-click
//! self-host provisioning are held exclusively in ephemeral Desktop process memory to call
//! the provider API directly from the user's workstation. They are never serialized to logs
//! or transmitted to `kodera.io`.

#![forbid(unsafe_code)]

mod commands;
pub mod csp_policy;
pub mod deeplink;
pub mod gui;
pub mod keychain;
pub mod notifications;
pub mod oidc_loopback;
pub mod self_host_deploy;
pub mod self_host_health;
pub mod shell;
pub mod tray_ptt;
pub mod window_state;

pub use commands::{
    begin_desktop_oidc_pkce_loopback, complete_desktop_oidc_pkce_callback, configure_desktop_ptt,
    delete_desktop_keychain_credential, deploy_desktop_community_stack,
    dispatch_desktop_notification, get_desktop_ptt_state, get_desktop_tray_state,
    inspect_desktop_self_host_health, load_desktop_keychain_credential,
    preflight_desktop_community_stack, prepare_desktop_community_stack,
    restore_desktop_window_bounds, route_desktop_deep_link, set_desktop_ptt_pressed,
    set_desktop_unread_badge, store_desktop_keychain_credential, trigger_desktop_tray_menu_action,
    update_desktop_tray_state, validate_desktop_keychain_metadata, DesktopCommandError,
    DesktopCommandRequest, DesktopCommandResponse, ProximityMemberStatus, MAX_IPC_COMMAND_BYTES,
    REGISTERED_DESKTOP_COMMANDS,
};
pub use csp_policy::{
    verify_desktop_csp, verify_embedded_tauri_conf_csp, CspPolicyError, APPROVED_CONNECT_SOURCES,
};
pub use deeplink::{
    route_deep_link, AdmittedDeepLink, DeepLinkAdmissionPolicy, DeepLinkError, KoderaDeepLink,
    MatrixAction, MatrixDeepLink, MatrixTarget, RedactedOidcCode, DEFAULT_ADMITTED_DOMAINS,
    MAX_ADMITTED_DEEP_LINK_DOMAINS, MAX_DEEP_LINK_BYTES, MAX_MATRIX_VIA_SERVERS,
};
pub use gui::{
    build_ipc_init_script, launch_desktop_gui, resolve_asset_response, validate_navigation_url,
    validate_privileged_ipc_sender, AssetHttpPayload, DesktopGuiOptions, DesktopWebViewBridge,
    GuiWindowAction, NavigationDecision, NavigationGuardError, WebViewIpcError, WebViewIpcOutcome,
    APPROVED_AUTH_ORIGIN_PREFIX, APPROVED_DEV_ORIGINS, APPROVED_STAGING_AUTH_ORIGIN_PREFIX,
    APPROVED_WEB_APP_ORIGINS, CUSTOM_ASSET_SCHEME, DESKTOP_WINDOW_TITLE, GUI_DEFAULT_HEIGHT,
    GUI_DEFAULT_WIDTH, GUI_MIN_HEIGHT, GUI_MIN_WIDTH,
};
pub use keychain::{
    build_keychain_slot, metadata_exposes_secret, validate_keychain_account_id,
    validate_keychain_service_id, KeychainCredentialStatus, KeychainCredentialStore, KeychainError,
    KeychainSecretKind, KeychainSessionMetadata, KeychainSlotDescriptor, OsKeychainCommandSpec,
    OsKeychainPlatform, RedactedSessionSecret, KEYCHAIN_SERVICE_NAMESPACE,
    MAX_KEYCHAIN_ACCOUNT_BYTES, MAX_KEYCHAIN_SECRET_BYTES, MAX_KEYCHAIN_SERVICE_BYTES,
    MAX_KEYCHAIN_SLOTS_PER_ORG, MIN_KEYCHAIN_SECRET_BYTES,
};
pub use notifications::{
    DesktopNotificationRequest, DispatchedNotification, DockBadgeSnapshot, NotificationCenter,
    NotificationError, MAX_NOTIFICATION_BODY_BYTES, MAX_NOTIFICATION_HISTORY,
    MAX_NOTIFICATION_TITLE_BYTES, REDACTED_NOTIFICATION_PREVIEW,
};
pub use oidc_loopback::{
    pkce_s256_challenge, OidcCallbackOutcome, OidcIssuerAllowlist, OidcLoopbackError,
    OidcLoopbackListener, OidcLoopbackSessionReady, OidcPkceSession, RedactedCodeVerifier,
    DEFAULT_LOOPBACK_TIMEOUT_MS, DEFAULT_OIDC_ISSUER_ORIGIN, MAX_LOOPBACK_HTTP_REQUEST_BYTES,
    MAX_LOOPBACK_TIMEOUT_MS, MAX_OIDC_CALLBACK_URI_BYTES,
};
pub use self_host_deploy::{
    self_host_deploy_community, self_host_preflight_community, self_host_prepare_community,
    CommandExecOutput, CommunityCommandRunner, CommunityCoreService, CommunityDeployError,
    CommunityDeployReport, CommunityDeployServiceStatus, CommunityPreflightReport,
    CommunityPreflightSpec, CommunityPrepareReport, CommunityPrepareSpec, CommunityTlsMode,
    StdProcessCommunityRunner, COMPOSE_CONFIG_TIMEOUT_MS, DEFAULT_DEPLOY_TIMEOUT_MS,
    HEX_SECRET_BYTES, LIVEKIT_KEY_RANDOM_BYTES, MAX_DEPLOY_TIMEOUT_MS, MAX_DOMAIN_BYTES,
    MAX_EMAIL_BYTES, MAX_OIDC_ORIGIN_BYTES, MAX_STACK_DIR_BYTES, MIN_DEPLOY_TIMEOUT_MS,
    PREFLIGHT_COMMAND_TIMEOUT_MS, READINESS_MAX_POLL_ATTEMPTS, SEAL_KEY_BYTES,
};
pub use self_host_health::{
    classify_docker_stderr, inspect_community_compose_ps, probe_local_community_stack,
    CommunityProbeHandle, CommunityServiceRole, DockerUnavailableReason, MemoryBudgetWarning,
    ProbeDisconnectedError, SelfHostHealthError, SelfHostHealthReport, ServiceHealthDiagnostic,
    ServiceReadiness, StackHealthState, COMMUNITY_MEMORY_BUDGET_MIB, DEFAULT_PROBE_TIMEOUT_MS,
    MAX_COMPOSE_CONTAINERS, MAX_COMPOSE_PS_JSON_BYTES, MAX_PROBE_TIMEOUT_MS,
};
pub use shell::{
    classify_launch_args, run_cli, DesktopLaunchMode, DesktopRuntimeMetadata,
    DesktopSelfCheckReport, DesktopShellError, DesktopShellHost, DESKTOP_APP_VERSION,
    DESKTOP_PRODUCT_NAME,
};
pub use tray_ptt::{
    PttController, PttKeyChord, PttModifier, PttStateSnapshot, PttTransmissionState, PttTriggerKey,
    TrayCallKind, TrayController, TrayIndicator, TrayMenuActionOutcome, TrayMenuEntry,
    TrayMenuItemId, TrayMenuModel, TrayPttError, TrayStateSnapshot, MAX_PTT_CHORD_BYTES,
    MAX_TRAY_BADGE_DIRECT, MAX_TRAY_UNREAD_COUNT,
};
pub use window_state::{
    load_window_state, parse_signed_i32, sanitize_and_clamp_window_state, save_window_state_atomic,
    MonitorWorkArea, RestoredWindowPlacement, SavedWindowState, WindowBounds, WindowStateError,
    DEFAULT_WINDOW_HEIGHT, DEFAULT_WINDOW_WIDTH, MAX_MONITORS, MAX_WINDOW_DIMENSION,
    MAX_WINDOW_STATE_JSON_BYTES, MIN_VISIBLE_TITLEBAR_PX, MIN_WINDOW_HEIGHT, MIN_WINDOW_WIDTH,
    TITLEBAR_REACHABLE_HEIGHT_PX,
};

/// Canonical reverse-DNS bundle identifier for the Kodera Tauri v2 shell.
pub const DESKTOP_APP_IDENTIFIER: &str = "io.kodera.desktop";

use core::fmt;
use kodera_rs::{
    compute_proximity_beacon, curated_desktop_themes, decode_shareable_theme,
    encode_shareable_theme, evaluate_channel_access, label_observed_proximity_senders, redact_iban,
    validate_channel_poll_id, validate_connector_post_url, validate_docs_host,
    validate_docs_pad_url, validate_user_profile, ChannelAccessDecision, ChannelPermissionPolicy,
    ChannelPoll, ChannelPollSnapshot, CoreError, CoreThemeMode, DeviceIdentitySigner,
    DocsPadDocument, DocsPadUrl, Ed25519PublicKey, ExtensionWebhookVerifier, OrganisationId,
    ProximityFrame, ProximityHandle, ProximityMeshQueue, ProximityReplayGuard,
    ProximityRosterLabel, ProximityRosterTracker, SafetyStatus, ShareableThemePayload,
    SignatureVerifier, SoundPackId, UserProfile, UuidV7, VerifiedProximityFrame,
    MAX_PROXIMITY_STATE_ENTRIES, MAX_PROXIMITY_TTL_HOPS,
};
pub use kodera_rs::{
    derive_extension_webhook_secret, ProximityOrganisationKeyGuard, ScopedWebhookVerifierRegistry,
};
use std::collections::{BTreeMap, HashSet};

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
/// unconditionally redact the underlying secret material.
#[derive(Clone)]
pub struct RedactedApiToken(String);

impl RedactedApiToken {
    pub fn new(raw: impl Into<String>) -> Result<Self, DeployValidationError> {
        let s = raw.into();
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
        Ok(Self(trimmed.to_owned()))
    }

    /// Exposes the raw token strictly for outbound HTTPS `Authorization` headers to `provider.api_origin()`.
    pub fn expose_for_provider_call(&self) -> &str {
        &self.0
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
#[derive(Debug, Clone)]
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
        raw_token: &str,
    ) -> Result<Self, DeployValidationError> {
        let (region_norm, fqdn_norm, email_norm) =
            Self::validate_public_fields(region, fqdn, acme_email)?;
        let token = RedactedApiToken::new(raw_token)?;
        Ok(Self {
            provider,
            region: region_norm,
            fqdn: fqdn_norm,
            acme_email: email_norm,
            token,
        })
    }

    fn validate_public_fields(
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

fn constant_time_eq_8(a: &[u8; 8], b: &[u8; 8]) -> bool {
    a.iter()
        .zip(b.iter())
        .fold(0u8, |acc, (x, y)| acc | (x ^ y))
        == 0
}

/// Bridges `#proximity` BLE/Wi-Fi frame verification from `kodera-rs` to the Desktop IPC layer.
///
/// Accepts the current 5-minute beacon bucket as well as ±1 adjacent bucket (`±300s`) so offline
/// workstations/phones without NTP do not drop proximity check-ins at window edges.
pub fn verify_incoming_proximity_packet(
    observed_beacon: [u8; 8],
    org_beacon_salt: &[u8; 32],
    now_unix_secs: u64,
    raw_frame: &[u8],
    allowed_roster: &HashSet<Ed25519PublicKey>,
    verifier: &dyn SignatureVerifier,
    replay_guard: &mut ProximityReplayGuard,
) -> Result<Option<ProximityFrame>, CoreError> {
    let verified = verified_incoming_proximity_packet(
        observed_beacon,
        org_beacon_salt,
        now_unix_secs,
        raw_frame,
        allowed_roster,
        verifier,
    )?;
    if !replay_guard.accept_once(verified.frame().message_id) {
        return Ok(None);
    }
    Ok(Some(verified.frame().clone()))
}

/// Verifies an incoming proximity packet against the local system wall-clock (`SystemTime::now()`).
pub fn verify_incoming_proximity_packet_now(
    observed_beacon: [u8; 8],
    org_beacon_salt: &[u8; 32],
    raw_frame: &[u8],
    allowed_roster: &HashSet<Ed25519PublicKey>,
    verifier: &dyn SignatureVerifier,
    replay_guard: &mut ProximityReplayGuard,
) -> Result<Option<ProximityFrame>, CoreError> {
    verify_incoming_proximity_packet(
        observed_beacon,
        org_beacon_salt,
        kodera_rs::system_unix_secs(),
        raw_frame,
        allowed_roster,
        verifier,
        replay_guard,
    )
}

fn verified_incoming_proximity_packet(
    observed_beacon: [u8; 8],
    org_beacon_salt: &[u8; 32],
    now_unix_secs: u64,
    raw_frame: &[u8],
    allowed_roster: &HashSet<Ed25519PublicKey>,
    verifier: &dyn SignatureVerifier,
) -> Result<VerifiedProximityFrame, CoreError> {
    let candidates = [
        now_unix_secs.saturating_sub(300),
        now_unix_secs,
        now_unix_secs.saturating_add(300),
    ];
    let beacon_matches = candidates.iter().any(|&ts| {
        let expected = compute_proximity_beacon(org_beacon_salt, ts);
        constant_time_eq_8(&observed_beacon, &expected)
    });
    if !beacon_matches {
        return Err(CoreError::UnauthorizedSender);
    }
    // The receive path reads the verifier's clock: a frame dated past the shared skew bound
    // would otherwise outrank every real check-in from its sender until the clock caught up.
    ProximityFrame::decode(raw_frame)?.verified_at(
        allowed_roster,
        verifier,
        now_unix_secs.saturating_mul(1000),
    )
}

/// Stateful backend seam for a future desktop IPC/radio adapter. It performs no radio,
/// network, key storage or provisioning operation. Only a trusted native signature provider
/// may supply `signer`/`verifier`; these are not caller-selectable IPC payloads.
pub struct DesktopProximityNode {
    org_beacon_salt: [u8; 32],
    allowed_roster: HashSet<Ed25519PublicKey>,
    /// Pseudonyms members picked, by provisioned key. Display metadata only: never consulted to
    /// admit, refuse or deduplicate anything.
    dedicated_handles: BTreeMap<Ed25519PublicKey, ProximityHandle>,
    replay_guard: ProximityReplayGuard,
    mesh_queue: ProximityMeshQueue,
    roster: ProximityRosterTracker,
}

impl DesktopProximityNode {
    /// Logical teardown plus overwriting the salt. Rust allocations/allocator copies are not
    /// guaranteed to be physically zeroised; this is not a secure-memory implementation.
    fn clear(&mut self) {
        self.org_beacon_salt.fill(0);
        self.allowed_roster.clear();
        self.dedicated_handles.clear();
        self.replay_guard.clear();
        self.mesh_queue.clear();
        self.roster.clear();
    }

    pub fn new(
        org_beacon_salt: [u8; 32],
        allowed_roster: HashSet<Ed25519PublicKey>,
        max_queue_capacity: usize,
    ) -> Result<Self, CoreError> {
        if allowed_roster.len() > MAX_PROXIMITY_STATE_ENTRIES {
            return Err(CoreError::InvalidCapacity);
        }
        Ok(Self {
            org_beacon_salt,
            roster: ProximityRosterTracker::new(allowed_roster.len())?,
            allowed_roster,
            dedicated_handles: BTreeMap::new(),
            replay_guard: ProximityReplayGuard::new(MAX_PROXIMITY_STATE_ENTRIES),
            mesh_queue: ProximityMeshQueue::new(max_queue_capacity)?,
        })
    }

    pub fn current_beacon(&self, now_unix_secs: u64) -> [u8; 8] {
        compute_proximity_beacon(&self.org_beacon_salt, now_unix_secs)
    }

    pub fn current_beacon_now(&self) -> [u8; 8] {
        self.current_beacon(kodera_rs::system_unix_secs())
    }

    pub fn create_local_checkin(
        &mut self,
        message_id: UuidV7,
        status: SafetyStatus,
        text: &str,
        signer: &dyn DeviceIdentitySigner,
        verifier: &dyn SignatureVerifier,
    ) -> Result<Vec<u8>, CoreError> {
        let frame =
            ProximityFrame::new_signed(message_id, MAX_PROXIMITY_TTL_HOPS, status, text, signer)?;
        let verified = frame.verified(&self.allowed_roster, verifier)?;
        let wire = frame.encode()?;
        if self.replay_guard.contains(&message_id) || self.mesh_queue.contains(&message_id) {
            return Err(CoreError::ReplayDetected);
        }
        if !self.roster.can_observe(&verified)? {
            return Err(CoreError::StaleFrame);
        }
        if !self.mesh_queue.enqueue_local(&verified) {
            return Err(CoreError::CapacityExceeded);
        }
        // Capacity is provisioned from the same immutable roster checked above.
        self.roster.observe(&verified)?;
        self.replay_guard.accept_once(message_id);
        Ok(wire)
    }

    pub fn ingest_peer_frame(
        &mut self,
        observed_beacon: [u8; 8],
        now_unix_secs: u64,
        raw_frame: &[u8],
        verifier: &dyn SignatureVerifier,
    ) -> Result<Option<ProximityFrame>, CoreError> {
        let verified = verified_incoming_proximity_packet(
            observed_beacon,
            &self.org_beacon_salt,
            now_unix_secs,
            raw_frame,
            &self.allowed_roster,
            verifier,
        )?;
        let frame = verified.frame();
        if self.replay_guard.contains(&frame.message_id) || !self.roster.can_observe(&verified)? {
            return Ok(None);
        }
        self.roster.observe(&verified)?;
        self.replay_guard.accept_once(frame.message_id);
        // A valid check-in still updates the roster when TTL is exhausted or lower-priority
        // radio traffic is refused by the bounded queue. Neither case invalidates its author.
        self.mesh_queue.enqueue_relay(&verified);
        Ok(Some(frame.clone()))
    }

    pub fn ingest_peer_frame_now(
        &mut self,
        observed_beacon: [u8; 8],
        raw_frame: &[u8],
        verifier: &dyn SignatureVerifier,
    ) -> Result<Option<ProximityFrame>, CoreError> {
        self.ingest_peer_frame(
            observed_beacon,
            kodera_rs::system_unix_secs(),
            raw_frame,
            verifier,
        )
    }

    #[allow(clippy::too_many_arguments)]
    pub fn create_org_bound_checkin(
        &mut self,
        organisation_id: &OrganisationId,
        now_unix_secs: u64,
        message_id: UuidV7,
        status: SafetyStatus,
        text: &str,
        signer: &dyn DeviceIdentitySigner,
        verifier: &dyn SignatureVerifier,
    ) -> Result<Vec<u8>, CoreError> {
        let beacon = self.current_beacon(now_unix_secs);
        let frame = ProximityFrame::sign_for_organisation(
            organisation_id,
            beacon,
            message_id,
            MAX_PROXIMITY_TTL_HOPS,
            status,
            text,
            signer,
        )?;
        let verified = frame.verified_for_organisation(
            organisation_id,
            beacon,
            &self.allowed_roster,
            verifier,
        )?;
        let wire = frame.encode()?;
        if self.replay_guard.contains(&message_id) || self.mesh_queue.contains(&message_id) {
            return Err(CoreError::ReplayDetected);
        }
        if !self.roster.can_observe(&verified)? {
            return Err(CoreError::StaleFrame);
        }
        if !self.mesh_queue.enqueue_local(&verified) {
            return Err(CoreError::CapacityExceeded);
        }
        self.roster.observe(&verified)?;
        self.replay_guard.accept_once(message_id);
        Ok(wire)
    }

    pub fn ingest_org_bound_peer_frame(
        &mut self,
        organisation_id: &OrganisationId,
        observed_beacon: [u8; 8],
        now_unix_secs: u64,
        raw_frame: &[u8],
        verifier: &dyn SignatureVerifier,
    ) -> Result<Option<ProximityFrame>, CoreError> {
        let candidates = [
            now_unix_secs.saturating_sub(300),
            now_unix_secs,
            now_unix_secs.saturating_add(300),
        ];
        let beacon_matches = candidates.iter().any(|&ts| {
            let expected = compute_proximity_beacon(&self.org_beacon_salt, ts);
            constant_time_eq_8(&observed_beacon, &expected)
        });
        if !beacon_matches {
            return Err(CoreError::UnauthorizedSender);
        }
        let verified = ProximityFrame::decode(raw_frame)?.verified_for_organisation_at(
            organisation_id,
            observed_beacon,
            &self.allowed_roster,
            verifier,
            now_unix_secs.saturating_mul(1000),
        )?;
        let frame = verified.frame();
        if self.replay_guard.contains(&frame.message_id) || !self.roster.can_observe(&verified)? {
            return Ok(None);
        }
        self.roster.observe(&verified)?;
        self.replay_guard.accept_once(frame.message_id);
        self.mesh_queue.enqueue_relay(&verified);
        Ok(Some(frame.clone()))
    }

    pub fn next_relay_batch(&mut self, max_frames: usize) -> Vec<Vec<u8>> {
        self.mesh_queue
            .drain(max_frames)
            .into_iter()
            .map(|frame| {
                frame
                    .encode()
                    .expect("verified queue entries remain valid after a hop decrement")
            })
            .collect()
    }

    /// Stable public-key order; each timestamp describes a historical check-in, not current safety.
    pub fn member_statuses(&self) -> Vec<(Ed25519PublicKey, SafetyStatus, String, u64)> {
        self.roster
            .statuses()
            .into_iter()
            .map(|member| {
                (
                    member.sender_public_key,
                    member.status,
                    member.text,
                    member.timestamp_ms,
                )
            })
            .collect()
    }

    /// Records the pseudonym a provisioned member picked. Trusted provisioning only: the key
    /// must already be in the roster and the handle inside the shared grammar. It changes what
    /// is displayed for that key and nothing else.
    pub fn provision_dedicated_handle(
        &mut self,
        sender_public_key: Ed25519PublicKey,
        raw_handle: &str,
    ) -> Result<(), CoreError> {
        if !self.allowed_roster.contains(&sender_public_key) {
            return Err(CoreError::UnauthorizedSender);
        }
        let handle = ProximityHandle::dedicated(raw_handle)?;
        self.dedicated_handles.insert(sender_public_key, handle);
        Ok(())
    }

    /// One display label per member that has checked in, in the order of
    /// [`Self::member_statuses`]. A handle is the member's dedicated pseudonym when one was
    /// provisioned, else derived from the sender key under this organisation's beacon salt.
    ///
    /// Equal handles are told apart with a fingerprint of the signing key keyed with this
    /// organisation's beacon salt (so it links nothing across organisations), and equality is judged
    /// over EVERY provisioned key, not over the members seen so far: a member whose handle equals
    /// that of someone who has not checked in yet already carries its fingerprint, so it cannot
    /// pass for the absent member and no label changes when that member appears. Labels are for
    /// display only: identity and admission stay with the key, the roster and the signature.
    pub fn member_labels(&self) -> Result<Vec<ProximityRosterLabel>, CoreError> {
        let provisioned: Vec<(Ed25519PublicKey, ProximityHandle)> =
            self.allowed_roster
                .iter()
                .map(|key| {
                    let handle =
                        self.dedicated_handles.get(key).cloned().unwrap_or_else(|| {
                            ProximityHandle::generated(&self.org_beacon_salt, key)
                        });
                    (*key, handle)
                })
                .collect();
        let observed: Vec<Ed25519PublicKey> = self
            .roster
            .statuses()
            .into_iter()
            .map(|member| member.sender_public_key)
            .collect();
        label_observed_proximity_senders(&self.org_beacon_salt, &provisioned, &observed)
    }
}

/// Organisation-bound native backend seam. A future trusted adapter owns provisioning and crypto;
/// no live Tauri command registration, cloud operation or radio transport is provided here.
/// The node is private so callers cannot retain a mutable reference across an organisation switch.
pub struct DesktopWorkspaceSession {
    organisation_id: Option<OrganisationId>,
    proximity: Option<DesktopProximityNode>,
    allowed_docs_host: Option<String>,
    extension_webhooks: Option<ExtensionWebhookVerifier>,
    sound_pack: Option<SoundPackId>,
    channel_polls: BTreeMap<(String, String), ChannelPoll>,
    theme_mode: CoreThemeMode,
    custom_theme: Option<ShareableThemePayload>,
    user_profile: Option<UserProfile>,
    docs_pads: BTreeMap<String, DocsPadDocument>,
    deep_link_policy: DeepLinkAdmissionPolicy,
    tray: TrayController,
    ptt: PttController,
    monitors: Vec<MonitorWorkArea>,
    window_placement: RestoredWindowPlacement,
    notifications: NotificationCenter,
    keychain_store: KeychainCredentialStore,
    oidc_allowlist: OidcIssuerAllowlist,
    pending_oidc: Option<OidcPkceSession>,
    community_runner: std::sync::Arc<dyn CommunityCommandRunner>,
}

impl DesktopWorkspaceSession {
    pub fn new(
        organisation_id: &str,
        org_beacon_salt: [u8; 32],
        allowed_roster: HashSet<Ed25519PublicKey>,
        max_queue_capacity: usize,
    ) -> Result<Self, CoreError> {
        let organisation_id = OrganisationId::parse(organisation_id)?;
        let proximity =
            DesktopProximityNode::new(org_beacon_salt, allowed_roster, max_queue_capacity)?;
        let extension_webhooks =
            ExtensionWebhookVerifier::new(organisation_id.clone(), MAX_PROXIMITY_STATE_ENTRIES)?;
        let monitors = vec![MonitorWorkArea::fallback_primary()];
        let window_placement = sanitize_and_clamp_window_state(None, &monitors)
            .expect("fallback primary monitor geometry is valid");
        Ok(Self {
            organisation_id: Some(organisation_id),
            proximity: Some(proximity),
            allowed_docs_host: None,
            extension_webhooks: Some(extension_webhooks),
            sound_pack: Some(SoundPackId::Givre),
            channel_polls: BTreeMap::new(),
            theme_mode: CoreThemeMode::RealBlack,
            custom_theme: None,
            user_profile: None,
            docs_pads: BTreeMap::new(),
            deep_link_policy: DeepLinkAdmissionPolicy::kodera_default(),
            tray: TrayController::new(),
            ptt: PttController::new(),
            monitors,
            window_placement,
            notifications: NotificationCenter::new(),
            keychain_store: KeychainCredentialStore::new(),
            oidc_allowlist: OidcIssuerAllowlist::kodera_default(),
            pending_oidc: None,
            community_runner: std::sync::Arc::new(StdProcessCommunityRunner::new()),
        })
    }

    pub fn organisation_id(&self) -> Option<&str> {
        self.organisation_id.as_ref().map(OrganisationId::as_str)
    }

    /// In-memory preferences only; selecting a pack does not start native audio output.
    pub fn set_sound_pack(
        &mut self,
        organisation_id: &str,
        sound_pack: SoundPackId,
    ) -> Result<(), CoreError> {
        self.check_organisation(organisation_id)?;
        self.sound_pack = Some(sound_pack);
        Ok(())
    }

    pub fn sound_pack(&self, organisation_id: &str) -> Result<SoundPackId, CoreError> {
        self.check_organisation(organisation_id)?;
        self.sound_pack.ok_or(CoreError::TransportUnavailable)
    }

    fn check_organisation(&self, organisation_id: &str) -> Result<(), CoreError> {
        let expected = OrganisationId::parse(organisation_id)?;
        match &self.organisation_id {
            Some(current) if current == &expected => Ok(()),
            Some(_) => Err(CoreError::OrganisationMismatch),
            None => Err(CoreError::TransportUnavailable),
        }
    }

    pub fn current_beacon(
        &self,
        organisation_id: &str,
        now_unix_secs: u64,
    ) -> Result<[u8; 8], CoreError> {
        self.check_organisation(organisation_id)?;
        self.proximity
            .as_ref()
            .map(|node| node.current_beacon(now_unix_secs))
            .ok_or(CoreError::TransportUnavailable)
    }

    pub fn current_beacon_now(&self, organisation_id: &str) -> Result<[u8; 8], CoreError> {
        self.current_beacon(organisation_id, kodera_rs::system_unix_secs())
    }

    pub fn create_local_checkin(
        &mut self,
        organisation_id: &str,
        message_id: UuidV7,
        status: SafetyStatus,
        text: &str,
        signer: &dyn DeviceIdentitySigner,
        verifier: &dyn SignatureVerifier,
    ) -> Result<Vec<u8>, CoreError> {
        self.check_organisation(organisation_id)?;
        self.proximity
            .as_mut()
            .ok_or(CoreError::TransportUnavailable)?
            .create_local_checkin(message_id, status, text, signer, verifier)
    }

    pub fn ingest_peer_frame(
        &mut self,
        organisation_id: &str,
        observed_beacon: [u8; 8],
        now_unix_secs: u64,
        raw_frame: &[u8],
        verifier: &dyn SignatureVerifier,
    ) -> Result<Option<ProximityFrame>, CoreError> {
        self.check_organisation(organisation_id)?;
        self.proximity
            .as_mut()
            .ok_or(CoreError::TransportUnavailable)?
            .ingest_peer_frame(observed_beacon, now_unix_secs, raw_frame, verifier)
    }

    pub fn ingest_peer_frame_now(
        &mut self,
        organisation_id: &str,
        observed_beacon: [u8; 8],
        raw_frame: &[u8],
        verifier: &dyn SignatureVerifier,
    ) -> Result<Option<ProximityFrame>, CoreError> {
        self.ingest_peer_frame(
            organisation_id,
            observed_beacon,
            kodera_rs::system_unix_secs(),
            raw_frame,
            verifier,
        )
    }

    #[allow(clippy::too_many_arguments)]
    pub fn create_org_bound_checkin(
        &mut self,
        organisation_id: &str,
        now_unix_secs: u64,
        message_id: UuidV7,
        status: SafetyStatus,
        text: &str,
        signer: &dyn DeviceIdentitySigner,
        verifier: &dyn SignatureVerifier,
    ) -> Result<Vec<u8>, CoreError> {
        self.check_organisation(organisation_id)?;
        let org = OrganisationId::parse(organisation_id)?;
        self.proximity
            .as_mut()
            .ok_or(CoreError::TransportUnavailable)?
            .create_org_bound_checkin(
                &org,
                now_unix_secs,
                message_id,
                status,
                text,
                signer,
                verifier,
            )
    }

    pub fn ingest_org_bound_peer_frame(
        &mut self,
        organisation_id: &str,
        observed_beacon: [u8; 8],
        now_unix_secs: u64,
        raw_frame: &[u8],
        verifier: &dyn SignatureVerifier,
    ) -> Result<Option<ProximityFrame>, CoreError> {
        self.check_organisation(organisation_id)?;
        let org = OrganisationId::parse(organisation_id)?;
        self.proximity
            .as_mut()
            .ok_or(CoreError::TransportUnavailable)?
            .ingest_org_bound_peer_frame(&org, observed_beacon, now_unix_secs, raw_frame, verifier)
    }

    pub fn member_statuses(
        &self,
        organisation_id: &str,
    ) -> Result<Vec<(Ed25519PublicKey, SafetyStatus, String, u64)>, CoreError> {
        self.check_organisation(organisation_id)?;
        self.proximity
            .as_ref()
            .map(DesktopProximityNode::member_statuses)
            .ok_or(CoreError::TransportUnavailable)
    }

    /// Display labels for the current organisation's roster, in [`Self::member_statuses`] order.
    pub fn member_labels(
        &self,
        organisation_id: &str,
    ) -> Result<Vec<ProximityRosterLabel>, CoreError> {
        self.check_organisation(organisation_id)?;
        self.proximity
            .as_ref()
            .ok_or(CoreError::TransportUnavailable)?
            .member_labels()
    }

    /// Records the pseudonym a provisioned member picked, for the current organisation only.
    /// A trusted adapter calls this from provisioning; it is not a JSON route.
    pub fn provision_dedicated_handle(
        &mut self,
        organisation_id: &str,
        sender_public_key: Ed25519PublicKey,
        raw_handle: &str,
    ) -> Result<(), CoreError> {
        self.check_organisation(organisation_id)?;
        self.proximity
            .as_mut()
            .ok_or(CoreError::TransportUnavailable)?
            .provision_dedicated_handle(sender_public_key, raw_handle)
    }

    pub fn next_relay_batch(
        &mut self,
        organisation_id: &str,
        max_frames: usize,
    ) -> Result<Vec<Vec<u8>>, CoreError> {
        self.check_organisation(organisation_id)?;
        self.proximity
            .as_mut()
            .map(|node| node.next_relay_batch(max_frames))
            .ok_or(CoreError::TransportUnavailable)
    }

    /// Trusted session configuration only, never a host chosen from an incoming pad link.
    /// Invalid replacements leave the existing policy untouched; None explicitly unprovisions Docs.
    pub fn configure_docs_host(
        &mut self,
        organisation_id: &str,
        host: Option<&str>,
    ) -> Result<(), CoreError> {
        self.check_organisation(organisation_id)?;
        if let Some(host) = host {
            validate_docs_host(host)?;
        }
        self.allowed_docs_host = host.map(str::to_owned);
        Ok(())
    }

    /// Returns read-only validated metadata. Does not navigate, fetch or grant document access.
    pub fn validate_docs_pad_url(
        &self,
        organisation_id: &str,
        raw_url: &str,
    ) -> Result<DocsPadUrl, CoreError> {
        self.check_organisation(organisation_id)?;
        let host = self
            .allowed_docs_host
            .as_deref()
            .ok_or(CoreError::TransportUnavailable)?;
        validate_docs_pad_url(raw_url, host)
    }

    /// Native protocol seam, not the extension SDK webhook format or an exposed IPC API.
    /// A trusted adapter selects an org/extension-specific secret; this session never retains it.
    #[allow(clippy::too_many_arguments)]
    pub fn verify_extension_webhook(
        &mut self,
        organisation_id: &str,
        extension_id: &str,
        delivery_id: UuidV7,
        timestamp_secs: u64,
        now_unix_secs: u64,
        secret: &[u8; 32],
        payload: &[u8],
        signature_hex: &str,
    ) -> Result<(), CoreError> {
        self.check_organisation(organisation_id)?;
        let organisation = self
            .organisation_id
            .as_ref()
            .ok_or(CoreError::TransportUnavailable)?;
        self.extension_webhooks
            .as_mut()
            .ok_or(CoreError::TransportUnavailable)?
            .verify_and_record(
                organisation,
                extension_id,
                delivery_id,
                timestamp_secs,
                now_unix_secs,
                secret,
                payload,
                signature_hex,
            )
    }

    /// Context-bound native webhook verification deriving `HMAC-SHA256(secret, org_id || ":" || ext_id)`
    /// so a reused raw secret cannot replay a webhook across organisations or extensions.
    #[allow(clippy::too_many_arguments)]
    pub fn verify_scoped_extension_webhook(
        &mut self,
        organisation_id: &str,
        extension_id: &str,
        delivery_id: UuidV7,
        timestamp_secs: u64,
        now_unix_secs: u64,
        secret: &[u8; 32],
        payload: &[u8],
        signature_hex: &str,
    ) -> Result<(), CoreError> {
        self.check_organisation(organisation_id)?;
        let organisation = self
            .organisation_id
            .as_ref()
            .ok_or(CoreError::TransportUnavailable)?;
        self.extension_webhooks
            .as_mut()
            .ok_or(CoreError::TransportUnavailable)?
            .verify_and_record_scoped(
                organisation,
                extension_id,
                delivery_id,
                timestamp_secs,
                now_unix_secs,
                secret,
                payload,
                signature_hex,
            )
    }

    /// Bounded local polls only. Trusted adapters establish channel/voter authority separately.
    #[allow(clippy::too_many_arguments)]
    pub fn create_channel_poll(
        &mut self,
        organisation_id: &str,
        channel_id: &str,
        poll_id: &str,
        question: &str,
        options: &[String],
        allow_multiple: bool,
    ) -> Result<ChannelPollSnapshot, CoreError> {
        self.check_organisation(organisation_id)?;
        validate_channel_poll_id(channel_id)?;
        validate_channel_poll_id(poll_id)?;
        let key = (channel_id.to_owned(), poll_id.to_owned());
        if self.channel_polls.contains_key(&key) {
            return Err(CoreError::PollExists);
        }
        if self.channel_polls.len() == 32 {
            return Err(CoreError::CapacityExceeded);
        }
        let poll = ChannelPoll::new(
            OrganisationId::parse(organisation_id)?,
            channel_id,
            question,
            options,
            allow_multiple,
            kodera_rs::MAX_CHANNEL_POLL_VOTERS,
        )?;
        let snapshot = poll.snapshot();
        self.channel_polls.insert(key, poll);
        Ok(snapshot)
    }

    pub fn channel_poll(
        &self,
        organisation_id: &str,
        channel_id: &str,
        poll_id: &str,
    ) -> Result<ChannelPollSnapshot, CoreError> {
        self.check_organisation(organisation_id)?;
        validate_channel_poll_id(channel_id)?;
        validate_channel_poll_id(poll_id)?;
        self.channel_polls
            .get(&(channel_id.to_owned(), poll_id.to_owned()))
            .map(ChannelPoll::snapshot)
            .ok_or(CoreError::PollNotFound)
    }

    pub fn vote_channel_poll(
        &mut self,
        organisation_id: &str,
        channel_id: &str,
        poll_id: &str,
        voter_id: &str,
        selections: &[usize],
    ) -> Result<ChannelPollSnapshot, CoreError> {
        self.check_organisation(organisation_id)?;
        validate_channel_poll_id(channel_id)?;
        validate_channel_poll_id(poll_id)?;
        let poll = self
            .channel_polls
            .get_mut(&(channel_id.to_owned(), poll_id.to_owned()))
            .ok_or(CoreError::PollNotFound)?;
        poll.vote(
            &OrganisationId::parse(organisation_id)?,
            channel_id,
            voter_id,
            selections,
        )?;
        Ok(poll.snapshot())
    }

    pub fn close_channel_poll(
        &mut self,
        organisation_id: &str,
        channel_id: &str,
        poll_id: &str,
    ) -> Result<ChannelPollSnapshot, CoreError> {
        self.check_organisation(organisation_id)?;
        validate_channel_poll_id(channel_id)?;
        validate_channel_poll_id(poll_id)?;
        let poll = self
            .channel_polls
            .get_mut(&(channel_id.to_owned(), poll_id.to_owned()))
            .ok_or(CoreError::PollNotFound)?;
        poll.close(&OrganisationId::parse(organisation_id)?, channel_id)?;
        Ok(poll.snapshot())
    }

    /// Structural masking only; the raw value is never retained by this session.
    pub fn redact_connector_iban(
        &self,
        organisation_id: &str,
        raw: &str,
    ) -> Result<String, CoreError> {
        self.check_organisation(organisation_id)?;
        redact_iban(raw)
    }

    pub fn validate_connector_post_url(
        &self,
        organisation_id: &str,
        raw: &str,
    ) -> Result<String, CoreError> {
        self.check_organisation(organisation_id)?;
        validate_connector_post_url(raw)
    }

    pub fn set_theme_mode(
        &mut self,
        organisation_id: &str,
        mode: CoreThemeMode,
    ) -> Result<CoreThemeMode, CoreError> {
        self.check_organisation(organisation_id)?;
        self.theme_mode = mode;
        self.custom_theme = None;
        Ok(self.theme_mode)
    }

    pub fn theme_mode(&self, organisation_id: &str) -> Result<CoreThemeMode, CoreError> {
        self.check_organisation(organisation_id)?;
        Ok(self.theme_mode)
    }

    pub fn import_shareable_theme(
        &mut self,
        organisation_id: &str,
        share_code: &str,
    ) -> Result<ShareableThemePayload, CoreError> {
        self.check_organisation(organisation_id)?;
        let payload = decode_shareable_theme(share_code)?;
        self.theme_mode = payload.base_mode;
        self.custom_theme = Some(payload.clone());
        Ok(payload)
    }

    pub fn export_shareable_theme(&self, organisation_id: &str) -> Result<String, CoreError> {
        self.check_organisation(organisation_id)?;
        if let Some(custom) = &self.custom_theme {
            return encode_shareable_theme(custom);
        }
        let fallback = curated_desktop_themes()
            .into_iter()
            .find(|t| t.base_mode == self.theme_mode)
            .ok_or(CoreError::InvalidTheme)?;
        encode_shareable_theme(&fallback)
    }

    pub fn update_user_profile(
        &mut self,
        organisation_id: &str,
        profile: UserProfile,
    ) -> Result<UserProfile, CoreError> {
        self.check_organisation(organisation_id)?;
        validate_user_profile(&profile)?;
        self.user_profile = Some(profile.clone());
        Ok(profile)
    }

    pub fn user_profile(&self, organisation_id: &str) -> Result<Option<UserProfile>, CoreError> {
        self.check_organisation(organisation_id)?;
        Ok(self.user_profile.clone())
    }

    /// Hypothetical local rank calculation only; it never grants service permissions.
    pub fn evaluate_channel_iam(
        &self,
        organisation_id: &str,
        rank: kodera_rs::OrgRoleRank,
        policy: &ChannelPermissionPolicy,
    ) -> Result<ChannelAccessDecision, CoreError> {
        self.check_organisation(organisation_id)?;
        Ok(evaluate_channel_access(rank, policy))
    }

    pub fn save_docs_pad(
        &mut self,
        organisation_id: &str,
        pad_id: &str,
        channel_id: &str,
        title: &str,
        markdown_body: &str,
        editor_handle: &str,
    ) -> Result<DocsPadDocument, CoreError> {
        self.check_organisation(organisation_id)?;
        let candidate =
            DocsPadDocument::new(pad_id, channel_id, title, markdown_body, editor_handle)?;
        let key = pad_id.to_owned();
        if let Some(existing) = self.docs_pads.get_mut(&key) {
            if existing.channel_id != channel_id {
                return Err(CoreError::InvalidDocsPad);
            }
            existing.validate_and_advance(title, markdown_body, editor_handle)?;
            return Ok(existing.clone());
        }
        if self.docs_pads.len() >= kodera_rs::MAX_DOCS_PADS {
            return Err(CoreError::CapacityExceeded);
        }
        let created = candidate;
        self.docs_pads
            .insert(created.pad_id.clone(), created.clone());
        Ok(created)
    }

    pub fn docs_pad(
        &self,
        organisation_id: &str,
        pad_id: &str,
    ) -> Result<Option<DocsPadDocument>, CoreError> {
        self.check_organisation(organisation_id)?;
        Ok(self.docs_pads.get(pad_id).cloned())
    }

    /// Trusted session configuration adding tenant Matrix/workspace domains to the default
    /// deep-link allowlist. Invalid domain replacements leave the active policy unchanged.
    pub fn configure_deep_link_domains(
        &mut self,
        organisation_id: &str,
        extra_domains: &[&str],
    ) -> Result<(), DesktopCommandError> {
        self.check_organisation(organisation_id)
            .map_err(DesktopCommandError::Core)?;
        let mut candidate = DeepLinkAdmissionPolicy::kodera_default();
        for domain in extra_domains {
            candidate
                .add_domain(domain)
                .map_err(DesktopCommandError::DeepLink)?;
        }
        self.deep_link_policy = candidate;
        Ok(())
    }

    pub fn route_deep_link(
        &self,
        organisation_id: &str,
        raw_uri: &str,
    ) -> Result<AdmittedDeepLink, DesktopCommandError> {
        self.check_organisation(organisation_id)
            .map_err(DesktopCommandError::Core)?;
        deeplink::route_deep_link(raw_uri, &self.deep_link_policy)
            .map_err(DesktopCommandError::DeepLink)
    }

    pub fn update_tray_state(
        &mut self,
        organisation_id: &str,
        unread_count: u32,
        active_call: Option<TrayCallKind>,
        muted: bool,
        self_host_degraded: bool,
    ) -> Result<TrayStateSnapshot, DesktopCommandError> {
        self.check_organisation(organisation_id)
            .map_err(DesktopCommandError::Core)?;
        self.tray
            .update_all(unread_count, active_call, muted, self_host_degraded)
            .map_err(DesktopCommandError::TrayPtt)?;
        self.notifications
            .set_unread_count(unread_count)
            .map_err(DesktopCommandError::Notification)?;
        if active_call.is_none() {
            self.ptt.force_release();
        }
        Ok(self.tray.snapshot(self.ptt.is_transmitting()))
    }

    pub fn tray_state(&self, organisation_id: &str) -> Result<TrayStateSnapshot, CoreError> {
        self.check_organisation(organisation_id)?;
        Ok(self.tray.snapshot(self.ptt.is_transmitting()))
    }

    pub fn tray_menu(&self, organisation_id: &str) -> Result<TrayMenuModel, CoreError> {
        self.check_organisation(organisation_id)?;
        Ok(self.tray.menu_model(self.ptt.is_transmitting()))
    }

    pub fn trigger_tray_menu_action(
        &mut self,
        organisation_id: &str,
        action: TrayMenuItemId,
    ) -> Result<TrayMenuActionOutcome, DesktopCommandError> {
        self.check_organisation(organisation_id)
            .map_err(DesktopCommandError::Core)?;
        let outcome = self
            .tray
            .handle_menu_action(action, self.ptt.is_transmitting());
        if matches!(action, TrayMenuItemId::OpenKodera) {
            self.window_placement.visible = true;
        }
        Ok(outcome)
    }

    pub fn configure_monitors(
        &mut self,
        organisation_id: &str,
        monitors: Vec<MonitorWorkArea>,
    ) -> Result<RestoredWindowPlacement, DesktopCommandError> {
        self.check_organisation(organisation_id)
            .map_err(DesktopCommandError::Core)?;
        let current_saved = SavedWindowState {
            bounds: self.window_placement.bounds,
            maximized: self.window_placement.maximized,
            fullscreen: self.window_placement.fullscreen,
            visible: self.window_placement.visible,
        };
        let placement = sanitize_and_clamp_window_state(Some(&current_saved), &monitors)
            .map_err(DesktopCommandError::WindowState)?;
        self.monitors = if monitors.is_empty() {
            vec![MonitorWorkArea::fallback_primary()]
        } else {
            monitors
        };
        self.window_placement = placement.clone();
        Ok(placement)
    }

    pub fn restore_window_bounds(
        &mut self,
        organisation_id: &str,
        saved_state_json: Option<&str>,
    ) -> Result<RestoredWindowPlacement, DesktopCommandError> {
        self.check_organisation(organisation_id)
            .map_err(DesktopCommandError::Core)?;
        let parsed = match saved_state_json {
            Some(raw) => {
                Some(SavedWindowState::from_json(raw).map_err(DesktopCommandError::WindowState)?)
            }
            None => None,
        };
        let placement = sanitize_and_clamp_window_state(parsed.as_ref(), &self.monitors)
            .map_err(DesktopCommandError::WindowState)?;
        self.window_placement = placement.clone();
        Ok(placement)
    }

    pub fn window_placement(
        &self,
        organisation_id: &str,
    ) -> Result<RestoredWindowPlacement, CoreError> {
        self.check_organisation(organisation_id)?;
        Ok(self.window_placement.clone())
    }

    pub fn set_unread_badge(
        &mut self,
        organisation_id: &str,
        unread_count: u32,
    ) -> Result<DockBadgeSnapshot, DesktopCommandError> {
        self.check_organisation(organisation_id)
            .map_err(DesktopCommandError::Core)?;
        let badge = self
            .notifications
            .set_unread_count(unread_count)
            .map_err(DesktopCommandError::Notification)?;
        self.tray
            .set_unread_count(unread_count)
            .map_err(DesktopCommandError::TrayPtt)?;
        Ok(badge)
    }

    pub fn dock_badge(&self, organisation_id: &str) -> Result<DockBadgeSnapshot, CoreError> {
        self.check_organisation(organisation_id)?;
        Ok(self.notifications.dock_badge().clone())
    }

    pub fn dispatch_notification(
        &mut self,
        organisation_id: &str,
        request: &DesktopNotificationRequest,
    ) -> Result<DispatchedNotification, DesktopCommandError> {
        self.check_organisation(organisation_id)
            .map_err(DesktopCommandError::Core)?;
        self.notifications
            .dispatch(request, &self.deep_link_policy)
            .map_err(DesktopCommandError::Notification)
    }

    #[allow(clippy::too_many_arguments)]
    pub fn store_keychain_credential(
        &mut self,
        organisation_id: &str,
        secret_kind: KeychainSecretKind,
        matrix_user_id: &str,
        device_id: &str,
        issued_at_unix_secs: u64,
        expires_at_unix_secs: Option<u64>,
        raw_secret: &str,
    ) -> Result<KeychainSessionMetadata, DesktopCommandError> {
        self.check_organisation(organisation_id)
            .map_err(DesktopCommandError::Core)?;
        self.keychain_store
            .store_credential(
                secret_kind,
                organisation_id,
                matrix_user_id,
                device_id,
                issued_at_unix_secs,
                expires_at_unix_secs,
                raw_secret,
            )
            .map_err(DesktopCommandError::Keychain)
    }

    pub fn load_keychain_credential(
        &self,
        organisation_id: &str,
        secret_kind: KeychainSecretKind,
        matrix_user_id: &str,
    ) -> Result<KeychainCredentialStatus, DesktopCommandError> {
        self.check_organisation(organisation_id)
            .map_err(DesktopCommandError::Core)?;
        self.keychain_store
            .load_credential_status(secret_kind, organisation_id, matrix_user_id)
            .map_err(DesktopCommandError::Keychain)
    }

    pub fn delete_keychain_credential(
        &mut self,
        organisation_id: &str,
        secret_kind: KeychainSecretKind,
        matrix_user_id: &str,
    ) -> Result<KeychainCredentialStatus, DesktopCommandError> {
        self.check_organisation(organisation_id)
            .map_err(DesktopCommandError::Core)?;
        self.keychain_store
            .delete_credential(secret_kind, organisation_id, matrix_user_id)
            .map_err(DesktopCommandError::Keychain)
    }

    pub fn configure_oidc_issuers(
        &mut self,
        organisation_id: &str,
        extra_origins: &[&str],
    ) -> Result<(), DesktopCommandError> {
        self.check_organisation(organisation_id)
            .map_err(DesktopCommandError::Core)?;
        let mut candidate = OidcIssuerAllowlist::kodera_default();
        for origin in extra_origins {
            candidate
                .add_issuer_origin(origin)
                .map_err(DesktopCommandError::OidcLoopback)?;
        }
        self.oidc_allowlist = candidate;
        Ok(())
    }

    pub fn begin_oidc_pkce_loopback(
        &mut self,
        organisation_id: &str,
        issuer_origin: &str,
        client_id: &str,
        raw_code_verifier: &str,
        expected_state: &str,
        loopback_port: u16,
    ) -> Result<OidcLoopbackSessionReady, DesktopCommandError> {
        self.check_organisation(organisation_id)
            .map_err(DesktopCommandError::Core)?;
        let (session, ready) = OidcPkceSession::start(
            &self.oidc_allowlist,
            issuer_origin,
            client_id,
            raw_code_verifier,
            expected_state,
            loopback_port,
        )
        .map_err(DesktopCommandError::OidcLoopback)?;
        if let Some(mut old) = self.pending_oidc.replace(session) {
            old.clear();
        }
        Ok(ready)
    }

    pub fn complete_oidc_pkce_callback(
        &mut self,
        organisation_id: &str,
        callback_uri: &str,
    ) -> Result<OidcCallbackOutcome, DesktopCommandError> {
        self.check_organisation(organisation_id)
            .map_err(DesktopCommandError::Core)?;
        let pending = self
            .pending_oidc
            .take()
            .ok_or(DesktopCommandError::OidcLoopback(
                OidcLoopbackError::NoPendingSession,
            ))?;
        pending
            .consume_callback_uri(callback_uri, &self.deep_link_policy)
            .map_err(DesktopCommandError::OidcLoopback)
    }

    pub fn configure_ptt(
        &mut self,
        organisation_id: &str,
        opt_in: bool,
        raw_chord: Option<&str>,
    ) -> Result<PttStateSnapshot, DesktopCommandError> {
        self.check_organisation(organisation_id)
            .map_err(DesktopCommandError::Core)?;
        self.ptt
            .configure(opt_in, raw_chord)
            .map_err(DesktopCommandError::TrayPtt)
    }

    pub fn set_ptt_pressed(
        &mut self,
        organisation_id: &str,
        pressed: bool,
        now_ms: u64,
    ) -> Result<PttStateSnapshot, DesktopCommandError> {
        self.check_organisation(organisation_id)
            .map_err(DesktopCommandError::Core)?;
        let snapshot = if pressed {
            self.ptt.press(now_ms)
        } else {
            self.ptt.release()
        };
        snapshot.map_err(DesktopCommandError::TrayPtt)
    }

    pub fn ptt_state(&self, organisation_id: &str) -> Result<PttStateSnapshot, CoreError> {
        self.check_organisation(organisation_id)?;
        Ok(self.ptt.snapshot())
    }

    #[allow(clippy::too_many_arguments)]
    pub fn validate_keychain_metadata(
        &self,
        organisation_id: &str,
        secret_kind: KeychainSecretKind,
        matrix_user_id: &str,
        device_id: &str,
        issued_at_unix_secs: u64,
        expires_at_unix_secs: Option<u64>,
        raw_secret: Option<&str>,
    ) -> Result<KeychainSessionMetadata, DesktopCommandError> {
        self.check_organisation(organisation_id)
            .map_err(DesktopCommandError::Core)?;
        let (metadata, _redacted_secret) = KeychainSessionMetadata::validate_with_secret(
            secret_kind,
            organisation_id,
            matrix_user_id,
            device_id,
            issued_at_unix_secs,
            expires_at_unix_secs,
            raw_secret,
        )
        .map_err(DesktopCommandError::Keychain)?;
        Ok(metadata)
    }

    pub fn inspect_self_host_health(
        &mut self,
        organisation_id: &str,
        raw_ps_json: &str,
    ) -> Result<SelfHostHealthReport, DesktopCommandError> {
        self.check_organisation(organisation_id)
            .map_err(DesktopCommandError::Core)?;
        let report = inspect_community_compose_ps(raw_ps_json, &BTreeMap::new())
            .map_err(DesktopCommandError::SelfHostHealth)?;
        self.tray.set_self_host_degraded(!report.is_healthy());
        Ok(report)
    }

    /// Trusted adapter or test seam replacing the local `docker` CLI runner for this session.
    pub fn configure_community_runner(
        &mut self,
        organisation_id: &str,
        runner: std::sync::Arc<dyn CommunityCommandRunner>,
    ) -> Result<(), CoreError> {
        self.check_organisation(organisation_id)?;
        self.community_runner = runner;
        Ok(())
    }

    pub fn preflight_community_deploy(
        &self,
        organisation_id: &str,
        spec: &CommunityPreflightSpec<'_>,
    ) -> Result<CommunityPreflightReport, DesktopCommandError> {
        self.check_organisation(organisation_id)
            .map_err(DesktopCommandError::Core)?;
        self_host_preflight_community(spec, self.community_runner.as_ref())
            .map_err(DesktopCommandError::CommunityDeploy)
    }

    pub fn prepare_community_deploy(
        &self,
        organisation_id: &str,
        spec: &CommunityPrepareSpec<'_>,
    ) -> Result<CommunityPrepareReport, DesktopCommandError> {
        self.check_organisation(organisation_id)
            .map_err(DesktopCommandError::Core)?;
        self_host_prepare_community(spec, self.community_runner.as_ref())
            .map_err(DesktopCommandError::CommunityDeploy)
    }

    pub fn deploy_community_stack(
        &mut self,
        organisation_id: &str,
        stack_dir: &str,
        timeout_ms: Option<u64>,
    ) -> Result<CommunityDeployReport, DesktopCommandError> {
        self.check_organisation(organisation_id)
            .map_err(DesktopCommandError::Core)?;
        match self_host_deploy_community(stack_dir, timeout_ms, self.community_runner.as_ref()) {
            Ok(report) => {
                self.tray.set_self_host_degraded(!report.stack_healthy);
                Ok(report)
            }
            Err(err) => {
                if matches!(
                    err,
                    CommunityDeployError::ComposeLaunchFailed
                        | CommunityDeployError::ReadinessProbeFailed(_)
                        | CommunityDeployError::StackUnhealthy
                ) {
                    self.tray.set_self_host_degraded(true);
                }
                Err(DesktopCommandError::CommunityDeploy(err))
            }
        }
    }

    pub fn clear_session(&mut self) {
        if let Some(node) = &mut self.proximity {
            node.clear();
        }
        self.proximity = None;
        self.allowed_docs_host = None;
        if let Some(verifier) = &mut self.extension_webhooks {
            verifier.clear();
        }
        self.extension_webhooks = None;
        self.sound_pack = None;
        self.channel_polls.clear();
        self.theme_mode = CoreThemeMode::RealBlack;
        self.custom_theme = None;
        self.user_profile = None;
        self.docs_pads.clear();
        self.deep_link_policy = DeepLinkAdmissionPolicy::kodera_default();
        self.tray.clear();
        self.ptt.clear();
        self.monitors = vec![MonitorWorkArea::fallback_primary()];
        self.window_placement = sanitize_and_clamp_window_state(None, &self.monitors)
            .expect("fallback primary monitor geometry is valid");
        self.notifications.clear();
        self.keychain_store.clear_all();
        self.oidc_allowlist = OidcIssuerAllowlist::kodera_default();
        if let Some(mut pending) = self.pending_oidc.take() {
            pending.clear();
        }
        self.community_runner = std::sync::Arc::new(StdProcessCommunityRunner::new());
        self.organisation_id = None;
    }

    /// Clear first, even if replacement provisioning is invalid. Failed switches stay unprovisioned.
    pub fn switch_organisation(
        &mut self,
        organisation_id: &str,
        org_beacon_salt: [u8; 32],
        allowed_roster: HashSet<Ed25519PublicKey>,
        max_queue_capacity: usize,
    ) -> Result<(), CoreError> {
        self.clear_session();
        *self = Self::new(
            organisation_id,
            org_beacon_salt,
            allowed_roster,
            max_queue_capacity,
        )?;
        Ok(())
    }
}

impl Drop for DesktopWorkspaceSession {
    fn drop(&mut self) {
        self.clear_session();
    }
}

/// Rust-callable command seam; not registered with a running Tauri shell yet.
pub fn emit_proximity_checkin(
    node: &mut DesktopProximityNode,
    message_id: UuidV7,
    status: SafetyStatus,
    text: &str,
    signer: &dyn DeviceIdentitySigner,
    verifier: &dyn SignatureVerifier,
) -> Result<Vec<u8>, CoreError> {
    node.create_local_checkin(message_id, status, text, signer, verifier)
}

pub fn ingest_ble_frame(
    node: &mut DesktopProximityNode,
    observed_beacon: [u8; 8],
    now_unix_secs: u64,
    raw_frame: &[u8],
    verifier: &dyn SignatureVerifier,
) -> Result<Option<ProximityFrame>, CoreError> {
    node.ingest_peer_frame(observed_beacon, now_unix_secs, raw_frame, verifier)
}

pub fn get_proximity_roster_status(
    node: &DesktopProximityNode,
) -> Vec<(Ed25519PublicKey, SafetyStatus, String, u64)> {
    node.member_statuses()
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

#[cfg(test)]
mod tests {
    use super::*;
    use kodera_rs::{hmac_sha256, DeviceIdentitySigner, Ed25519Signature, SafetyStatus, UuidV7};

    struct TestSigner {
        key: [u8; 32],
        pk: Ed25519PublicKey,
    }

    impl DeviceIdentitySigner for TestSigner {
        fn public_key(&self) -> Ed25519PublicKey {
            self.pk
        }
        fn sign(&self, message: &[u8]) -> Result<Ed25519Signature, CoreError> {
            let mac = hmac_sha256(&self.key, message);
            let mut sig = [0u8; 64];
            sig[0..32].copy_from_slice(&mac);
            sig[32..64].copy_from_slice(&mac);
            Ok(sig)
        }
    }

    impl SignatureVerifier for TestSigner {
        fn verify(
            &self,
            public_key: &Ed25519PublicKey,
            message: &[u8],
            signature: &Ed25519Signature,
        ) -> Result<(), CoreError> {
            if public_key != &self.pk {
                return Err(CoreError::UnauthorizedSender);
            }
            let expected = self.sign(message)?;
            if &expected != signature {
                return Err(CoreError::InvalidSignature);
            }
            Ok(())
        }
    }

    #[test]
    fn docs_pad_bounds_match_shared_native_cases() {
        for line in
            include_str!("../../../../packages/kodera-rs/tests/vectors/docs-pad/bounds.tsv").lines()
        {
            let fields: Vec<_> = line.split_whitespace().collect();
            let size: usize = fields[1].parse().unwrap();
            let expected = fields[2] == "true";
            let signer = TestSigner {
                key: [9; 32],
                pk: [9; 32],
            };
            let org = "11111111-1111-4111-8111-111111111111";
            let mut session =
                DesktopWorkspaceSession::new(org, [0x42; 32], HashSet::from([signer.pk]), 4)
                    .unwrap();
            let admitted = match fields[0] {
                "id" => session
                    .save_docs_pad(org, &"a".repeat(size), "channel", "Title", "", "actor")
                    .is_ok(),
                "count" => {
                    size > 0
                        && (0..size).all(|i| {
                            session
                                .save_docs_pad(
                                    org,
                                    &format!("pad-{i}"),
                                    "channel",
                                    "Title",
                                    "",
                                    "actor",
                                )
                                .is_ok()
                        })
                }
                _ => panic!("unknown bounds case"),
            };
            assert_eq!(admitted, expected, "{line}");
            if fields[0] == "count" && size >= kodera_rs::MAX_DOCS_PADS {
                assert!(session
                    .save_docs_pad(org, "pad-0", "channel", "Updated", "", "actor")
                    .is_ok());
            }
        }
    }

    #[test]
    fn token_never_leaks_in_debug_or_display() {
        let spec = SelfHostDeploymentSpec::validate(
            CloudProvider::Scaleway,
            "fr-par-1",
            "chat.acme-corp.eu",
            "ops@acme-corp.eu",
            "scw_secret_0123456789abcdef0123456789",
        )
        .expect("valid spec");

        let dbg_str = format!("{spec:?}");
        let disp_str = format!("{}", spec.token);
        assert!(!dbg_str.contains("scw_secret_"));
        assert!(!disp_str.contains("scw_secret_"));
        assert!(dbg_str.contains("REDACTED"));
        assert_eq!(spec.provider.api_origin(), "https://api.scaleway.com");
    }

    #[test]
    fn rejects_invalid_domains_and_short_tokens() {
        assert_eq!(
            SelfHostDeploymentSpec::validate(
                CloudProvider::Hetzner,
                "fsn1",
                "localhost",
                "ops@acme.eu",
                "htz_0123456789abcdef012345"
            )
            .unwrap_err(),
            DeployValidationError::InvalidDomain
        );
        assert_eq!(
            SelfHostDeploymentSpec::validate(
                CloudProvider::OvhCloud,
                "gra11",
                "kodera.acme.eu",
                "ops@acme.eu",
                "short"
            )
            .unwrap_err(),
            DeployValidationError::TokenTooShort
        );
        for bad_ip in ["127.0.0.1", "169.254.169.254"] {
            assert_eq!(
                SelfHostDeploymentSpec::validate(
                    CloudProvider::Scaleway,
                    "fr-par-1",
                    bad_ip,
                    "ops@acme.eu",
                    "scw_0123456789abcdef012345"
                )
                .unwrap_err(),
                DeployValidationError::InvalidDomain
            );
        }
        for bad_email in ["ops}@acme.eu", "ops$(id)@acme.eu", "ops\0@acme.eu"] {
            assert_eq!(
                SelfHostDeploymentSpec::validate(
                    CloudProvider::Scaleway,
                    "fr-par-1",
                    "kodera.acme.eu",
                    bad_email,
                    "scw_0123456789abcdef012345"
                )
                .unwrap_err(),
                DeployValidationError::InvalidAdminEmail
            );
        }
        assert_eq!(
            SelfHostDeploymentSpec::validate(
                CloudProvider::Scaleway,
                "fr-par-1",
                "kodera.acme.eu",
                "ops@acme.eu",
                "scw_0123456789ab\0def012345"
            )
            .unwrap_err(),
            DeployValidationError::TokenInvalidCharacters
        );
    }

    #[test]
    fn bridges_kodera_rs_proximity_frame_validation() {
        let salt = [0x55u8; 32];
        let now = 1_762_520_000;
        let beacon = compute_proximity_beacon(&salt, now);
        let signer = TestSigner {
            key: [0x99; 32],
            pk: [0x11; 32],
        };
        let msg_id = UuidV7::from_parts(now * 1000, [1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
        let frame =
            ProximityFrame::new_signed(msg_id, 3, SafetyStatus::Safe, "Floor 3 clear", &signer)
                .expect("sign");
        let wire = frame.encode().expect("encode");

        let mut roster = HashSet::new();
        roster.insert(signer.pk);
        let mut guard = ProximityReplayGuard::new(64);

        let accepted = verify_incoming_proximity_packet(
            beacon, &salt, now, &wire, &roster, &signer, &mut guard,
        )
        .expect("valid")
        .expect("first delivery");
        assert_eq!(accepted.text, "Floor 3 clear");

        // Duplicate delivery is suppressed by replay guard
        let duplicate = verify_incoming_proximity_packet(
            beacon, &salt, now, &wire, &roster, &signer, &mut guard,
        )
        .expect("valid");
        assert!(duplicate.is_none());
    }

    fn test_signer(byte: u8) -> TestSigner {
        TestSigner {
            key: [byte.wrapping_add(1); 32],
            pk: [byte; 32],
        }
    }

    fn frame(signer: &TestSigner, timestamp: u64, ttl: u8, status: SafetyStatus) -> ProximityFrame {
        ProximityFrame::new_signed(
            UuidV7::from_parts(timestamp, [3; 10]),
            ttl,
            status,
            "check-in",
            signer,
        )
        .unwrap()
    }

    fn node(signers: &[&TestSigner], capacity: usize) -> DesktopProximityNode {
        DesktopProximityNode::new([0x42; 32], signers.iter().map(|s| s.pk).collect(), capacity)
            .unwrap()
    }

    struct PairVerifier<'a>(&'a TestSigner, &'a TestSigner);
    impl SignatureVerifier for PairVerifier<'_> {
        fn verify(
            &self,
            pk: &Ed25519PublicKey,
            message: &[u8],
            sig: &Ed25519Signature,
        ) -> Result<(), CoreError> {
            if pk == &self.0.pk {
                self.0.verify(pk, message, sig)
            } else {
                self.1.verify(pk, message, sig)
            }
        }
    }

    #[test]
    fn relay_chain_decrements_three_to_two_to_one_and_stops() {
        let signer = test_signer(9);
        let now = 1_762_520_100;
        let wire3 = frame(&signer, now * 1000, 3, SafetyStatus::Safe)
            .encode()
            .unwrap();
        let mut first = node(&[&signer], 8);
        let mut second = node(&[&signer], 8);
        let mut third = node(&[&signer], 8);
        let beacon = first.current_beacon(now);
        assert_eq!(
            ingest_ble_frame(&mut first, beacon, now, &wire3, &signer)
                .unwrap()
                .unwrap()
                .ttl_hops,
            3
        );
        let wire2 = first.next_relay_batch(8).remove(0);
        assert_eq!(ProximityFrame::decode(&wire2).unwrap().ttl_hops, 2);
        second
            .ingest_peer_frame(beacon, now, &wire2, &signer)
            .unwrap();
        let wire1 = second.next_relay_batch(8).remove(0);
        assert_eq!(ProximityFrame::decode(&wire1).unwrap().ttl_hops, 1);
        third
            .ingest_peer_frame(beacon, now, &wire1, &signer)
            .unwrap();
        assert!(third.next_relay_batch(8).is_empty());
        assert_eq!(get_proximity_roster_status(&third)[0].1, SafetyStatus::Safe);
        assert!(first
            .ingest_peer_frame(beacon, now, &wire1, &signer)
            .unwrap()
            .is_none());
        assert!(first.next_relay_batch(8).is_empty());
    }

    #[test]
    fn proximity_node_prioritizes_help_and_does_not_roll_status_back() {
        let safe = test_signer(9);
        let help = test_signer(10);
        let verifier = PairVerifier(&safe, &help);
        let mut node = node(&[&safe, &help], 4);
        let now = 1_762_520_100;
        let beacon = node.current_beacon(now);
        node.ingest_peer_frame(
            beacon,
            now,
            &frame(&safe, 20, 3, SafetyStatus::Safe).encode().unwrap(),
            &verifier,
        )
        .unwrap();
        node.ingest_peer_frame(
            beacon,
            now,
            &frame(&help, 19, 3, SafetyStatus::NeedAssistance)
                .encode()
                .unwrap(),
            &verifier,
        )
        .unwrap();
        let batch = node.next_relay_batch(9);
        assert_eq!(
            ProximityFrame::decode(&batch[0]).unwrap().status,
            SafetyStatus::NeedAssistance
        );
        assert_eq!(
            ProximityFrame::decode(&batch[1]).unwrap().status,
            SafetyStatus::Safe
        );
        let old = frame(&safe, 18, 3, SafetyStatus::NeedAssistance)
            .encode()
            .unwrap();
        assert!(node
            .ingest_peer_frame(beacon, now, &old, &verifier)
            .unwrap()
            .is_none());
        assert_eq!(node.member_statuses()[0].1, SafetyStatus::Safe);
        assert_eq!(node.member_statuses()[0].3, 20);
        assert!(node.next_relay_batch(9).is_empty());
    }

    #[test]
    fn local_checkin_echo_is_suppressed_and_backend_preflight_redacts() {
        let signer = test_signer(9);
        let mut node = node(&[&signer], 4);
        let now = 1_762_520_100;
        let id = UuidV7::from_parts(now * 1000, [3; 10]);
        let wire =
            emit_proximity_checkin(&mut node, id, SafetyStatus::Safe, "Here", &signer, &signer)
                .unwrap();
        assert_eq!(
            ProximityFrame::decode(&wire).unwrap().ttl_hops,
            MAX_PROXIMITY_TTL_HOPS
        );
        assert_eq!(node.next_relay_batch(1), vec![wire.clone()]);
        assert!(node
            .ingest_peer_frame(node.current_beacon(now), now, &wire, &signer)
            .unwrap()
            .is_none());
        assert!(node.next_relay_batch(1).is_empty());
        assert_eq!(
            node.create_local_checkin(id, SafetyStatus::Safe, "Here", &signer, &signer),
            Err(CoreError::ReplayDetected)
        );
        assert_eq!(
            node.create_local_checkin(
                UuidV7::from_parts(now * 1000 - 1, [3; 10]),
                SafetyStatus::Safe,
                "Old",
                &signer,
                &signer
            ),
            Err(CoreError::StaleFrame)
        );
        let spec = preflight_self_host_spec(
            CloudProvider::Scaleway,
            "fr-par-1",
            "chat.example.test",
            "ops@example.test",
            "fixture_token_0123456789",
        )
        .unwrap();
        assert!(!format!("{spec:?}").contains("fixture_token_0123456789"));
        assert!(format!("{spec:?}").contains("REDACTED"));
        assert_eq!(
            preflight_self_host_spec(
                CloudProvider::Scaleway,
                "fr-par-1",
                "localhost",
                "ops@example.test",
                "fixture_token_0123456789"
            )
            .unwrap_err(),
            DeployValidationError::InvalidDomain
        );
        assert_eq!(
            preflight_self_host_spec(
                CloudProvider::Scaleway,
                "fr-par-1",
                "chat.example.test",
                "ops@example.test",
                "short"
            )
            .unwrap_err(),
            DeployValidationError::TokenTooShort
        );
    }

    #[test]
    fn peer_frame_dated_past_the_skew_bound_is_refused_and_cannot_mask_real_check_ins() {
        let signer = test_signer(11);
        let mut node = node(&[&signer], 4);
        let now = 1_762_520_100;
        let beacon = node.current_beacon(now);
        let ahead = frame(
            &signer,
            now * 1000 + kodera_rs::MAX_PROXIMITY_FUTURE_SKEW_MS + 1,
            3,
            SafetyStatus::Safe,
        )
        .encode()
        .unwrap();
        assert_eq!(
            node.ingest_peer_frame(beacon, now, &ahead, &signer),
            Err(CoreError::FutureFrame)
        );
        assert!(node.member_statuses().is_empty());
        assert!(node.next_relay_batch(4).is_empty());
        let real = frame(&signer, now * 1000, 3, SafetyStatus::NeedAssistance)
            .encode()
            .unwrap();
        assert!(node
            .ingest_peer_frame(beacon, now, &real, &signer)
            .unwrap()
            .is_some());
        let at_bound = frame(
            &signer,
            now * 1000 + kodera_rs::MAX_PROXIMITY_FUTURE_SKEW_MS,
            3,
            SafetyStatus::Safe,
        )
        .encode()
        .unwrap();
        assert!(node
            .ingest_peer_frame(beacon, now, &at_bound, &signer)
            .unwrap()
            .is_some());
    }

    #[test]
    fn invalid_packet_rejections_leave_state_and_replay_unmodified() {
        let signer = test_signer(9);
        let stranger = test_signer(10);
        let mut node = node(&[&signer], 4);
        let now = 1_762_520_100;
        let beacon = node.current_beacon(now);
        let wire = frame(&signer, now * 1000, 3, SafetyStatus::Safe)
            .encode()
            .unwrap();
        assert_eq!(
            node.ingest_peer_frame([0; 8], now, &wire, &signer),
            Err(CoreError::UnauthorizedSender)
        );
        let mut forged = wire.clone();
        forged[54] ^= 1;
        assert_eq!(
            node.ingest_peer_frame(beacon, now, &forged, &signer),
            Err(CoreError::InvalidSignature)
        );
        let outsider = frame(&stranger, now * 1000, 3, SafetyStatus::Safe)
            .encode()
            .unwrap();
        assert_eq!(
            node.ingest_peer_frame(beacon, now, &outsider, &stranger),
            Err(CoreError::UnauthorizedSender)
        );
        let mut invalid_ttl = wire.clone();
        invalid_ttl[51] = 0;
        assert_eq!(
            node.ingest_peer_frame(beacon, now, &invalid_ttl, &signer),
            Err(CoreError::InvalidTtl)
        );
        assert!(node.member_statuses().is_empty());
        assert!(node.next_relay_batch(4).is_empty());
        assert!(node
            .ingest_peer_frame(beacon, now, &wire, &signer)
            .unwrap()
            .is_some());
    }

    #[test]
    fn beacon_tolerance_is_adjacent_bucket_only_and_node_state_is_per_instance() {
        let signer = test_signer(9);
        let now = 1_762_520_100;
        let wire = frame(&signer, now * 1000, 3, SafetyStatus::Safe)
            .encode()
            .unwrap();
        for delta in [-300_i64, 0, 300] {
            let mut node = node(&[&signer], 4);
            let beacon = compute_proximity_beacon(&[0x42; 32], (now as i64 + delta) as u64);
            assert!(node
                .ingest_peer_frame(beacon, now, &wire, &signer)
                .unwrap()
                .is_some());
        }
        let mut isolated =
            DesktopProximityNode::new([0x43; 32], HashSet::from([signer.pk]), 4).unwrap();
        let wrong_org_beacon = compute_proximity_beacon(&[0x42; 32], now);
        assert_eq!(
            isolated.ingest_peer_frame(wrong_org_beacon, now, &wire, &signer),
            Err(CoreError::UnauthorizedSender)
        );
        let distant = compute_proximity_beacon(&[0x43; 32], now + 600);
        assert_eq!(
            isolated.ingest_peer_frame(distant, now, &wire, &signer),
            Err(CoreError::UnauthorizedSender)
        );
        assert!(isolated.member_statuses().is_empty());
    }

    #[test]
    fn v1_public_beacon_retagging_exposes_shared_signing_key_org_boundary() {
        let org_a = "11111111-1111-4111-8111-111111111111";
        let org_b = "22222222-2222-4222-8222-222222222222";
        let shared_signer = test_signer(9);
        let distinct_signer = test_signer(10);
        let now = 1_762_520_100;
        let mut sender =
            DesktopWorkspaceSession::new(org_a, [0x42; 32], HashSet::from([shared_signer.pk]), 4)
                .unwrap();
        let mut receiver =
            DesktopWorkspaceSession::new(org_b, [0x43; 32], HashSet::from([shared_signer.pk]), 4)
                .unwrap();
        let wire = sender
            .create_local_checkin(
                org_a,
                UuidV7::from_parts(now * 1000, [3; 10]),
                SafetyStatus::Safe,
                "Organisation A fixture",
                &shared_signer,
                &shared_signer,
            )
            .unwrap();
        let beacon_a = sender.current_beacon(org_a, now).unwrap();
        let beacon_b = receiver.current_beacon(org_b, now).unwrap();
        assert_ne!(beacon_a, beacon_b);
        assert_eq!(
            receiver.ingest_peer_frame(org_b, beacon_a, now, &wire, &shared_signer),
            Err(CoreError::UnauthorizedSender)
        );
        assert_eq!(
            receiver.ingest_peer_frame(org_a, beacon_b, now, &wire, &shared_signer),
            Err(CoreError::OrganisationMismatch)
        );
        assert!(receiver.member_statuses(org_b).unwrap().is_empty());

        // A public target beacon can be substituted without changing signed frame bytes.
        // This pins a v1 activation limitation, not successful cross-org authorisation.
        let accepted = receiver
            .ingest_peer_frame(org_b, beacon_b, now, &wire, &shared_signer)
            .unwrap()
            .unwrap();
        assert_eq!(accepted.text, "Organisation A fixture");
        assert_eq!(accepted.sender_public_key, shared_signer.pk);
        assert_eq!(receiver.member_statuses(org_b).unwrap().len(), 1);
        let relayed = receiver.next_relay_batch(org_b, 1).unwrap();
        assert_eq!(relayed.len(), 1);
        let relay = ProximityFrame::decode(&relayed[0]).unwrap();
        assert_eq!(relay.signature, accepted.signature);
        assert_eq!(relay.ttl_hops + 1, accepted.ttl_hops);

        // Target roster separation still rejects the same retagged packet before admission.
        let mut disjoint =
            DesktopWorkspaceSession::new(org_b, [0x43; 32], HashSet::from([distinct_signer.pk]), 4)
                .unwrap();
        assert_eq!(
            disjoint.ingest_peer_frame(org_b, beacon_b, now, &wire, &shared_signer),
            Err(CoreError::UnauthorizedSender)
        );
        assert!(disjoint.member_statuses(org_b).unwrap().is_empty());
        assert!(disjoint.next_relay_batch(org_b, 1).unwrap().is_empty());
    }

    #[test]
    fn org_bound_proximity_and_scoped_webhooks_reject_cross_org_retagging_and_secret_reuse() {
        let org_a = "11111111-1111-4111-8111-111111111111";
        let org_b = "22222222-2222-4222-8222-222222222222";
        let shared_signer = test_signer(9);
        let now = 1_762_520_100;

        // 1. ProximityOrganisationKeyGuard rejects registering the same Ed25519 key across orgs
        let mut key_guard = ProximityOrganisationKeyGuard::new();
        let beacon_a = compute_proximity_beacon(&[0x42; 32], now);
        let beacon_b = compute_proximity_beacon(&[0x43; 32], now);
        key_guard
            .register_roster(
                OrganisationId::parse(org_a).unwrap(),
                beacon_a,
                HashSet::from([shared_signer.pk]),
            )
            .unwrap();
        assert_eq!(
            key_guard.register_roster(
                OrganisationId::parse(org_b).unwrap(),
                beacon_b,
                HashSet::from([shared_signer.pk]),
            ),
            Err(CoreError::UnauthorizedSender)
        );

        // 2. Context-bound create_org_bound_checkin / ingest_org_bound_peer_frame rejects beacon retagging
        let mut sender =
            DesktopWorkspaceSession::new(org_a, [0x42; 32], HashSet::from([shared_signer.pk]), 4)
                .unwrap();
        let mut receiver =
            DesktopWorkspaceSession::new(org_b, [0x43; 32], HashSet::from([shared_signer.pk]), 4)
                .unwrap();
        let wire = sender
            .create_org_bound_checkin(
                org_a,
                now,
                UuidV7::from_parts(now * 1000, [3; 10]),
                SafetyStatus::Safe,
                "Org-bound fixture",
                &shared_signer,
                &shared_signer,
            )
            .unwrap();
        assert_eq!(
            receiver.ingest_org_bound_peer_frame(org_b, beacon_b, now, &wire, &shared_signer),
            Err(CoreError::InvalidSignature)
        );
        assert!(receiver.member_statuses(org_b).unwrap().is_empty());

        // 3. Context-bound verify_scoped_extension_webhook & ScopedWebhookVerifierRegistry reject secret reuse
        let secret = [0x42; 32];
        let delivery = UuidV7::from_parts(now * 1000, [4; 10]);
        let payload = b"{\"ok\":true}";
        let derived = derive_extension_webhook_secret(
            &secret,
            &OrganisationId::parse(org_a).unwrap(),
            "docs",
        )
        .unwrap();
        assert_ne!(derived, secret);
        let sig_a = ExtensionWebhookVerifier::sign_scoped_payload(
            &OrganisationId::parse(org_a).unwrap(),
            "docs",
            delivery,
            now,
            &secret,
            payload,
        )
        .unwrap();
        sender
            .verify_scoped_extension_webhook(
                org_a, "docs", delivery, now, now, &secret, payload, &sig_a,
            )
            .unwrap();
        assert_eq!(
            sender.verify_scoped_extension_webhook(
                org_a, "other", delivery, now, now, &secret, payload, &sig_a
            ),
            Err(CoreError::InvalidSignature)
        );
        assert_eq!(
            receiver.verify_scoped_extension_webhook(
                org_b, "docs", delivery, now, now, &secret, payload, &sig_a
            ),
            Err(CoreError::InvalidSignature)
        );
        let mut registry = ScopedWebhookVerifierRegistry::new(4).unwrap();
        registry
            .register_extension_secret(OrganisationId::parse(org_a).unwrap(), "docs", &secret)
            .unwrap();
        assert_eq!(
            registry.register_extension_secret(
                OrganisationId::parse(org_b).unwrap(),
                "docs",
                &secret
            ),
            Err(CoreError::UnauthorizedSender)
        );
    }

    #[test]
    fn bounded_node_refuses_local_overflow_without_changing_member_status() {
        let safe = test_signer(9);
        let help = test_signer(10);
        let verifier = PairVerifier(&safe, &help);
        let mut node = node(&[&safe, &help], 1);
        node.create_local_checkin(
            UuidV7::from_parts(20, [3; 10]),
            SafetyStatus::NeedAssistance,
            "Help",
            &help,
            &verifier,
        )
        .unwrap();
        assert_eq!(
            node.create_local_checkin(
                UuidV7::from_parts(21, [3; 10]),
                SafetyStatus::Safe,
                "Safe",
                &safe,
                &verifier
            ),
            Err(CoreError::CapacityExceeded)
        );
        assert_eq!(node.member_statuses().len(), 1);
        assert_eq!(node.member_statuses()[0].0, help.pk);
        assert!(matches!(
            DesktopProximityNode::new([0x42; 32], HashSet::new(), 0),
            Err(CoreError::InvalidCapacity)
        ));
        let roster = (0..4097u32)
            .map(|value| {
                let mut key = [0; 32];
                key[..4].copy_from_slice(&value.to_be_bytes());
                key
            })
            .collect();
        assert!(matches!(
            DesktopProximityNode::new([0x42; 32], roster, 1),
            Err(CoreError::InvalidCapacity)
        ));
    }

    const ORG: &str = "019a5e62-6ca0-7303-8303-030303030303";
    const OTHER_ORG: &str = "019a5e62-6ca0-7303-8303-030303030304";

    fn valid_spec() -> SelfHostDeploymentSpec {
        SelfHostDeploymentSpec::validate(
            CloudProvider::Scaleway,
            "fr-par-1",
            " CHAT.EXAMPLE.ORG ",
            "ops@example.org",
            "fixture-token-never-in-preview",
        )
        .unwrap()
    }

    #[test]
    fn deployment_plan_is_deterministic_public_and_secret_free() {
        for provider in [
            CloudProvider::Scaleway,
            CloudProvider::Hetzner,
            CloudProvider::Hostinger,
            CloudProvider::OvhCloud,
        ] {
            let mut spec = valid_spec();
            spec.provider = provider;
            let plan = SelfHostDeploymentPlan::from_spec(&spec).unwrap();
            assert_eq!(plan, SelfHostDeploymentPlan::from_spec(&spec).unwrap());
            assert_eq!(plan.provider, provider);
            assert_eq!(plan.region, "fr-par-1");
            let names = [
                "chat.example.org",
                "matrix.chat.example.org",
                "visio.chat.example.org",
                "docs.chat.example.org",
                "auth.chat.example.org",
            ];
            assert_eq!(
                plan.required_dns
                    .iter()
                    .map(|record| record.fqdn.as_str())
                    .collect::<Vec<_>>(),
                names
            );
            assert!(plan
                .required_dns
                .iter()
                .all(|record| record.target == PublicDnsTarget::AllocatedServerPublicAddresses));
            assert_eq!(
                plan.https_origins,
                names.map(|name| format!("https://{name}"))
            );
            assert_eq!(
                plan.community_public_config,
                BTreeMap::from([
                    ("KODERA_DOMAIN".to_owned(), "chat.example.org".to_owned()),
                    ("KODERA_ACME_EMAIL".to_owned(), "ops@example.org".to_owned())
                ])
            );
            for diagnostic in [
                format!("{spec:?}"),
                format!("{}", spec.token),
                format!("{plan:?}"),
                format!("{:?}", plan.community_public_config),
            ] {
                assert!(!diagnostic.contains("fixture-token-never-in-preview"));
            }
            assert_eq!(
                spec.token.expose_for_provider_call(),
                "fixture-token-never-in-preview"
            );
        }
    }

    #[test]
    fn deployment_plan_revalidates_mutable_spec_and_derived_domain_lengths() {
        let mut spec = valid_spec();
        for fqdn in [
            "localhost",
            "https://chat.example.org",
            "127.0.0.1",
            "bad.example.org/path",
            "bad\n.example.org",
        ] {
            spec.fqdn = fqdn.to_owned();
            assert_eq!(
                SelfHostDeploymentPlan::from_spec(&spec),
                Err(DeployValidationError::InvalidDomain)
            );
        }
        spec = valid_spec();
        spec.region = "fr-par-1; id".to_owned();
        assert_eq!(
            SelfHostDeploymentPlan::from_spec(&spec),
            Err(DeployValidationError::InvalidRegion)
        );
        spec = valid_spec();
        spec.acme_email = "ops@example.org\nKODERA_DOMAIN=invalid".to_owned();
        assert_eq!(
            SelfHostDeploymentPlan::from_spec(&spec),
            Err(DeployValidationError::InvalidAdminEmail)
        );
        let domain = format!(
            "{}.{}.{}.{}",
            "a".repeat(63),
            "b".repeat(63),
            "c".repeat(63),
            "d".repeat(61)
        );
        assert_eq!(domain.len(), 253);
        spec = SelfHostDeploymentSpec::validate(
            CloudProvider::Scaleway,
            "fr-par-1",
            &domain,
            "ops@example.org",
            "fixture-token-never-in-preview",
        )
        .unwrap();
        assert_eq!(
            SelfHostDeploymentPlan::from_spec(&spec),
            Err(DeployValidationError::InvalidDomain)
        );
        spec.fqdn = format!(
            "{}.{}.{}.{}",
            "a".repeat(63),
            "b".repeat(63),
            "c".repeat(63),
            "d".repeat(54)
        );
        let plan = SelfHostDeploymentPlan::from_spec(&spec).unwrap();
        assert_eq!(plan.required_dns[1].fqdn.len(), 253);
    }

    #[test]
    fn workspace_switch_clears_roster_replay_queue_and_old_provisioning() {
        let signer = test_signer(9);
        let replacement = test_signer(10);
        let now = 1_762_520_100;
        let mut session =
            DesktopWorkspaceSession::new(ORG, [0x42; 32], HashSet::from([signer.pk]), 4).unwrap();
        let id = UuidV7::from_parts(now * 1000, [3; 10]);
        let wire = session
            .create_local_checkin(ORG, id, SafetyStatus::Safe, "Here", &signer, &signer)
            .unwrap();
        assert_eq!(session.member_statuses(ORG).unwrap().len(), 1);
        assert_eq!(session.proximity.as_ref().unwrap().mesh_queue.len(), 1);
        assert!(session
            .proximity
            .as_ref()
            .unwrap()
            .replay_guard
            .contains(&id));
        assert_eq!(
            session.member_statuses(OTHER_ORG),
            Err(CoreError::OrganisationMismatch)
        );
        assert_eq!(
            session.next_relay_batch(OTHER_ORG, 1),
            Err(CoreError::OrganisationMismatch)
        );
        let old_beacon = session.current_beacon(ORG, now).unwrap();
        session
            .switch_organisation(OTHER_ORG, [0x43; 32], HashSet::from([replacement.pk]), 4)
            .unwrap();
        assert_eq!(session.organisation_id(), Some(OTHER_ORG));
        assert_eq!(
            session.member_statuses(ORG),
            Err(CoreError::OrganisationMismatch)
        );
        assert!(session.member_statuses(OTHER_ORG).unwrap().is_empty());
        assert!(session.next_relay_batch(OTHER_ORG, 10).unwrap().is_empty());
        let new_beacon = session.current_beacon(OTHER_ORG, now).unwrap();
        assert_ne!(old_beacon, new_beacon);
        assert_eq!(
            session.ingest_peer_frame(OTHER_ORG, old_beacon, now, &wire, &signer),
            Err(CoreError::UnauthorizedSender)
        );
        assert_eq!(
            session.ingest_peer_frame(OTHER_ORG, new_beacon, now, &wire, &signer),
            Err(CoreError::UnauthorizedSender)
        );
        // Same ID is usable by a legitimately provisioned different organisation, not inherited replay.
        session
            .create_local_checkin(
                OTHER_ORG,
                id,
                SafetyStatus::Safe,
                "Here",
                &replacement,
                &replacement,
            )
            .unwrap();
        session.clear_session();
        assert_eq!(session.organisation_id(), None);
        assert!(session.proximity.is_none());
        assert_eq!(
            session.current_beacon(OTHER_ORG, now),
            Err(CoreError::TransportUnavailable)
        );
        assert_eq!(
            session.create_local_checkin(
                OTHER_ORG,
                id,
                SafetyStatus::Safe,
                "Here",
                &replacement,
                &replacement
            ),
            Err(CoreError::TransportUnavailable)
        );
        session.clear_session();
    }

    #[test]
    fn failed_workspace_switch_leaves_no_old_session_and_node_clear_overwrites_salt() {
        let signer = test_signer(9);
        let mut node = node(&[&signer], 4);
        let id = UuidV7::from_parts(1, [3; 10]);
        node.create_local_checkin(id, SafetyStatus::Safe, "Here", &signer, &signer)
            .unwrap();
        node.clear();
        assert_eq!(node.org_beacon_salt, [0; 32]);
        assert!(node.allowed_roster.is_empty());
        assert!(!node.replay_guard.contains(&id));
        assert!(!node.mesh_queue.contains(&id));
        assert!(node.mesh_queue.is_empty());
        assert!(node.member_statuses().is_empty());
        for bad in [
            "",
            " org ",
            "00000000-0000-0000-0000-000000000000",
            "019A5e62-6ca0-7303-8303-030303030303",
        ] {
            assert!(matches!(
                DesktopWorkspaceSession::new(bad, [0x42; 32], HashSet::from([signer.pk]), 4),
                Err(CoreError::InvalidOrganisation)
            ));
        }
        let mut session =
            DesktopWorkspaceSession::new(ORG, [0x42; 32], HashSet::from([signer.pk]), 4).unwrap();
        assert_eq!(
            session.switch_organisation(OTHER_ORG, [0x43; 32], HashSet::from([signer.pk]), 0),
            Err(CoreError::InvalidCapacity)
        );
        assert!(session.proximity.is_none());
        assert_eq!(session.organisation_id(), None);
        assert_eq!(
            session.member_statuses(ORG),
            Err(CoreError::TransportUnavailable)
        );
    }

    #[test]
    fn docs_session_policy_is_explicit_org_bound_and_transactional() {
        let signer = test_signer(9);
        let mut session =
            DesktopWorkspaceSession::new(ORG, [0x42; 32], HashSet::from([signer.pk]), 4).unwrap();
        let url = "https://docs.example.org/docs/pad";
        assert_eq!(
            session.validate_docs_pad_url(ORG, url),
            Err(CoreError::TransportUnavailable)
        );
        assert_eq!(
            session.configure_docs_host(OTHER_ORG, Some("docs.example.org")),
            Err(CoreError::OrganisationMismatch)
        );
        assert!(session.allowed_docs_host.is_none());
        session
            .configure_docs_host(ORG, Some("docs.example.org"))
            .unwrap();
        assert_eq!(
            session.validate_docs_pad_url(ORG, url).unwrap().as_str(),
            url
        );
        assert_eq!(
            session.validate_docs_pad_url(OTHER_ORG, url),
            Err(CoreError::OrganisationMismatch)
        );
        assert_eq!(
            session.configure_docs_host(ORG, Some("localhost")),
            Err(CoreError::UntrustedDocsOrigin)
        );
        assert!(session.validate_docs_pad_url(ORG, url).is_ok());
        session.configure_docs_host(ORG, None).unwrap();
        assert_eq!(
            session.validate_docs_pad_url(ORG, url),
            Err(CoreError::TransportUnavailable)
        );
        session.clear_session();
        assert_eq!(
            session.configure_docs_host(ORG, Some("docs.example.org")),
            Err(CoreError::TransportUnavailable)
        );
    }

    #[test]
    fn extension_session_auth_replay_and_docs_policy_reset_across_org_switches() {
        let signer = test_signer(9);
        let mut session =
            DesktopWorkspaceSession::new(ORG, [0x42; 32], HashSet::from([signer.pk]), 4).unwrap();
        let now = 1_762_520_100;
        let id = UuidV7::from_parts(now * 1000, [3; 10]);
        let payload = [0, 255, 10, 58, 65];
        let mac = "83ece4ff7a8e78097259ad7127fe1281cb706c7d4ab94e73779de45429707150";
        session
            .configure_docs_host(ORG, Some("docs.example.org"))
            .unwrap();
        assert_eq!(
            session.verify_extension_webhook(
                OTHER_ORG,
                "docs",
                id,
                now,
                now,
                &[0x42; 32],
                &payload,
                mac
            ),
            Err(CoreError::OrganisationMismatch)
        );
        assert_eq!(
            session.extension_webhooks.as_ref().unwrap().replay_count(),
            0
        );
        assert_eq!(
            session.verify_extension_webhook(ORG, "docs", id, now, now, &[0x43; 32], &payload, mac),
            Err(CoreError::InvalidSignature)
        );
        session
            .verify_extension_webhook(ORG, "docs", id, now, now, &[0x42; 32], &payload, mac)
            .unwrap();
        assert_eq!(
            session.verify_extension_webhook(ORG, "docs", id, now, now, &[0x42; 32], &payload, mac),
            Err(CoreError::ReplayDetected)
        );
        session
            .switch_organisation(OTHER_ORG, [0x43; 32], HashSet::from([signer.pk]), 4)
            .unwrap();
        assert!(session.allowed_docs_host.is_none());
        assert_eq!(
            session.extension_webhooks.as_ref().unwrap().replay_count(),
            0
        );
        assert_eq!(
            session.validate_docs_pad_url(OTHER_ORG, "https://docs.example.org/docs/a"),
            Err(CoreError::TransportUnavailable)
        );
        assert_eq!(
            session.verify_extension_webhook(ORG, "docs", id, now, now, &[0x42; 32], &payload, mac),
            Err(CoreError::OrganisationMismatch)
        );
        // The same fixture is accepted under an incorrectly reused secret: org identity is not
        // signed in this protocol. Real adapters must provision pair-specific secrets instead.
        session
            .verify_extension_webhook(OTHER_ORG, "docs", id, now, now, &[0x42; 32], &payload, mac)
            .unwrap();
        session.clear_session();
        assert!(session.allowed_docs_host.is_none());
        assert!(session.extension_webhooks.is_none());
        assert_eq!(
            session.verify_extension_webhook(
                OTHER_ORG,
                "docs",
                id,
                now,
                now,
                &[0x42; 32],
                &payload,
                mac
            ),
            Err(CoreError::TransportUnavailable)
        );
    }

    #[test]
    fn failed_switch_clears_docs_and_extension_state_even_before_replacement_validation() {
        let signer = test_signer(9);
        let mut session =
            DesktopWorkspaceSession::new(ORG, [0x42; 32], HashSet::from([signer.pk]), 4).unwrap();
        session
            .configure_docs_host(ORG, Some("docs.example.org"))
            .unwrap();
        assert_eq!(
            session.switch_organisation("invalid", [0x43; 32], HashSet::from([signer.pk]), 4),
            Err(CoreError::InvalidOrganisation)
        );
        assert!(session.allowed_docs_host.is_none());
        assert!(session.extension_webhooks.is_none());
        assert!(session.organisation_id().is_none());
        assert_eq!(
            session.validate_docs_pad_url(ORG, "https://docs.example.org/docs/a"),
            Err(CoreError::TransportUnavailable)
        );
    }

    #[test]
    fn desktop_proximity_session_system_clock_helpers_verify_present_and_reject_future() {
        let signer = test_signer(11);
        let mut session =
            DesktopWorkspaceSession::new(ORG, [0x42; 32], HashSet::from([signer.pk]), 4).unwrap();
        let beacon = session.current_beacon_now(ORG).unwrap();
        let now_ms = kodera_rs::system_unix_ms();
        let valid_wire = ProximityFrame::new_signed(
            UuidV7::from_parts(now_ms, [0x01; 10]),
            3,
            SafetyStatus::Safe,
            "present",
            &signer,
        )
        .unwrap()
        .encode()
        .unwrap();
        let accepted = session
            .ingest_peer_frame_now(ORG, beacon, &valid_wire, &signer)
            .unwrap();
        assert!(accepted.is_some());

        let future_wire = ProximityFrame::new_signed(
            UuidV7::from_parts(now_ms + 360_000, [0x02; 10]),
            3,
            SafetyStatus::Safe,
            "future",
            &signer,
        )
        .unwrap()
        .encode()
        .unwrap();
        assert_eq!(
            session.ingest_peer_frame_now(ORG, beacon, &future_wire, &signer),
            Err(CoreError::FutureFrame)
        );
    }
}
