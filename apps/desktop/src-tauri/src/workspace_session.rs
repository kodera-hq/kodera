//! Organisation-bound native desktop workspace session state and core domain operations.

use crate::{
    sanitize_and_clamp_window_state, CommunityCommandRunner, DeepLinkAdmissionPolicy,
    DesktopProximityNode, KeychainCredentialStore, MediaCaptureController, MonitorWorkArea,
    NotificationCenter, OidcIssuerAllowlist, OidcPkceSession, PttController,
    RestoredWindowPlacement, StdProcessCommunityRunner, TrayController,
};
use kodera_rs::{
    curated_desktop_themes, decode_shareable_theme, encode_shareable_theme,
    evaluate_channel_access, redact_iban, validate_channel_poll_id, validate_connector_post_url,
    validate_docs_host, validate_docs_pad_url, validate_user_profile, ChannelAccessDecision,
    ChannelPermissionPolicy, ChannelPoll, ChannelPollSnapshot, CoreError, CoreThemeMode,
    DeviceIdentitySigner, DocsPadDocument, DocsPadUrl, Ed25519PublicKey, ExtensionWebhookVerifier,
    OrganisationId, ProximityFrame, ProximityRosterLabel, SafetyStatus, ShareableThemePayload,
    SignatureVerifier, SoundPackId, UserProfile, UuidV7, MAX_PROXIMITY_STATE_ENTRIES,
};
use std::collections::{BTreeMap, HashSet};

mod native_shell;
#[cfg(test)]
mod tests;

/// Organisation-bound native backend seam. A future trusted adapter owns provisioning and crypto;
/// no live Tauri command registration, cloud operation or radio transport is provided here.
/// The node is private so callers cannot retain a mutable reference across an organisation switch.
pub struct DesktopWorkspaceSession {
    pub(crate) organisation_id: Option<OrganisationId>,
    pub(crate) proximity: Option<DesktopProximityNode>,
    pub(crate) allowed_docs_host: Option<String>,
    pub(crate) extension_webhooks: Option<ExtensionWebhookVerifier>,
    pub(crate) sound_pack: Option<SoundPackId>,
    pub(crate) channel_polls: BTreeMap<(String, String), ChannelPoll>,
    pub(crate) theme_mode: CoreThemeMode,
    pub(crate) custom_theme: Option<ShareableThemePayload>,
    pub(crate) user_profile: Option<UserProfile>,
    pub(crate) docs_pads: BTreeMap<String, DocsPadDocument>,
    pub(crate) deep_link_policy: DeepLinkAdmissionPolicy,
    pub(crate) tray: TrayController,
    pub(crate) ptt: PttController,
    pub(crate) media_capture: MediaCaptureController,
    pub(crate) monitors: Vec<MonitorWorkArea>,
    pub(crate) window_placement: RestoredWindowPlacement,
    pub(crate) notifications: NotificationCenter,
    pub(crate) keychain_store: KeychainCredentialStore,
    pub(crate) oidc_allowlist: OidcIssuerAllowlist,
    pub(crate) pending_oidc: Option<OidcPkceSession>,
    pub(crate) community_runner: std::sync::Arc<dyn CommunityCommandRunner>,
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
            media_capture: MediaCaptureController::new(),
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

    pub(crate) fn check_organisation(&self, organisation_id: &str) -> Result<(), CoreError> {
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
        self.media_capture.clear();
        self.monitors = vec![MonitorWorkArea::fallback_primary()];
        self.window_placement = sanitize_and_clamp_window_state(None, &self.monitors)
            .expect("fallback primary monitor geometry is valid");
        self.notifications.clear();
        self.keychain_store.clear_ram_cache();
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
