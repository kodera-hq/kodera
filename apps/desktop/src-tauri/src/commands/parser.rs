//! Bounded flat JSON parser and schema decoder for [`DesktopCommandRequest`].

use super::{
    DesktopCommandError, DesktopCommandRequest, LEGACY_ROUTE_ALIASES, MAX_IPC_COMMAND_BYTES,
};
use crate::{CloudProvider, RedactedApiToken};
use kodera_rs::{
    ChannelPermissionPolicy, CoreThemeMode, OrgRoleRank, PresenceStatus, SoundPackId, UserProfile,
};
use std::collections::BTreeMap;
use zeroize::{Zeroize, Zeroizing};

fn canonical_route<'a>(command: &'a str, aliases: &[(&'static str, &'static str)]) -> &'a str {
    aliases
        .iter()
        .find(|(legacy, _)| *legacy == command)
        .map_or(command, |(_, canonical)| canonical)
}

impl DesktopCommandRequest {
    /// Strict command-only JSON: one flat object with schema scalars and bounded scalar arrays.
    /// Unknown/duplicate fields are refused, including duplicate escaped spellings of a key.
    /// Arrays have at most ten scalar elements; no recursive descent or nested objects.
    pub fn from_json(raw_json: &str) -> Result<Self, DesktopCommandError> {
        Self::from_json_with_aliases(raw_json, &LEGACY_ROUTE_ALIASES)
    }

    /// [`Self::from_json`] with the alias table as an argument, so a test can drop a pair and
    /// watch the legacy name be refused.
    pub(super) fn from_json_with_aliases(
        raw_json: &str,
        aliases: &[(&'static str, &'static str)],
    ) -> Result<Self, DesktopCommandError> {
        if raw_json.len() > MAX_IPC_COMMAND_BYTES {
            return Err(DesktopCommandError::RequestTooLarge);
        }
        let mut fields = FlatCommandParser {
            raw: raw_json,
            offset: 0,
        }
        .parse()?;
        let command = if fields.contains_key("op") {
            if fields.contains_key("command") {
                return Err(DesktopCommandError::InvalidRequest);
            }
            let operation = take_string(&mut fields, "op")?;
            if !matches!(
                operation.as_str(),
                "set_theme_mode"
                    | "import_shareable_theme"
                    | "export_shareable_theme"
                    | "update_user_profile"
                    | "evaluate_channel_iam"
                    | "save_docs_pad"
            ) {
                return Err(DesktopCommandError::InvalidRequest);
            }
            operation
        } else {
            take_string(&mut fields, "command")?
        };
        let organisation_id = take_string(&mut fields, "organisation_id")?;
        let request = match canonical_route(command.as_str(), aliases) {
            "create_channel_poll" => Self::CreateChannelPoll {
                organisation_id,
                channel_id: take_string(&mut fields, "channel_id")?,
                poll_id: take_string(&mut fields, "poll_id")?,
                question: take_string(&mut fields, "question")?,
                options: take_strings(&mut fields, "options")?,
                allow_multiple: take_bool(&mut fields, "allow_multiple")?,
            },
            "vote_channel_poll" => Self::VoteChannelPoll {
                organisation_id,
                channel_id: take_string(&mut fields, "channel_id")?,
                poll_id: take_string(&mut fields, "poll_id")?,
                voter_id: take_string(&mut fields, "voter_id")?,
                selections: take_integers(&mut fields, "selections")?,
            },
            "get_channel_poll" => Self::GetChannelPoll {
                organisation_id,
                channel_id: take_string(&mut fields, "channel_id")?,
                poll_id: take_string(&mut fields, "poll_id")?,
            },
            "close_channel_poll" => Self::CloseChannelPoll {
                organisation_id,
                channel_id: take_string(&mut fields, "channel_id")?,
                poll_id: take_string(&mut fields, "poll_id")?,
            },
            "redact_iban" => Self::RedactIban {
                organisation_id,
                raw_iban: take_string(&mut fields, "raw_iban")?,
            },
            "validate_connector_post_url" => Self::ValidateConnectorPostUrl {
                organisation_id,
                raw_url: take_string(&mut fields, "raw_url")?,
            },
            "plan_self_host" => {
                let provider = match take_string(&mut fields, "provider")?.as_str() {
                    "scaleway" => CloudProvider::Scaleway,
                    "hetzner" => CloudProvider::Hetzner,
                    "hostinger" => CloudProvider::Hostinger,
                    "ovhcloud" => CloudProvider::OvhCloud,
                    _ => return Err(DesktopCommandError::InvalidRequest),
                };
                let region = take_string(&mut fields, "region")?;
                let fqdn = take_string(&mut fields, "fqdn")?;
                let acme_email = take_string(&mut fields, "acme_email")?;
                let mut raw_token_bytes =
                    Zeroizing::new(take_string(&mut fields, "raw_token")?.into_bytes());
                if !fields.is_empty() {
                    return Err(DesktopCommandError::InvalidRequest);
                }
                let token = RedactedApiToken::validate_and_zeroize_slice(&mut raw_token_bytes)
                    .map_err(DesktopCommandError::Deployment)?;
                Self::PlanSelfHost {
                    organisation_id,
                    provider,
                    region,
                    fqdn,
                    acme_email,
                    token,
                }
            }
            "validate_docs_pad_url" => Self::ValidateDocsPadUrl {
                organisation_id,
                raw_url: take_string(&mut fields, "raw_url")?,
            },
            "proximity_current_beacon" => Self::ProximityCurrentBeacon {
                organisation_id,
                now_unix_secs: take_integer(&mut fields, "now_unix_secs")?,
            },
            "proximity_member_statuses" => Self::ProximityMemberStatuses { organisation_id },
            "proximity_next_relay_batch" => Self::ProximityNextRelayBatch {
                organisation_id,
                max_frames: usize::try_from(take_integer(&mut fields, "max_frames")?)
                    .map_err(|_| DesktopCommandError::InvalidRequest)?,
            },
            "clear_workspace_session" => Self::ClearWorkspaceSession { organisation_id },
            "set_sound_pack" => Self::SetSoundPack {
                organisation_id,
                sound_pack: SoundPackId::parse(&take_string(&mut fields, "sound_pack")?)
                    .map_err(DesktopCommandError::Core)?,
            },
            "get_sound_pack" => Self::GetSoundPack { organisation_id },
            "set_theme_mode" => Self::SetThemeMode {
                organisation_id,
                mode: CoreThemeMode::parse(&take_string(&mut fields, "mode")?)
                    .map_err(DesktopCommandError::Core)?,
            },
            "import_shareable_theme" => Self::ImportShareableTheme {
                organisation_id,
                share_code: take_string(&mut fields, "code")?,
            },
            "export_shareable_theme" => Self::ExportShareableTheme { organisation_id },
            "update_user_profile" => {
                let profile = UserProfile {
                    user_id: take_string(&mut fields, "user_id")?,
                    display_name: take_string(&mut fields, "display_name")?,
                    handle: take_string(&mut fields, "handle")?,
                    role_title: take_string(&mut fields, "role_title")?,
                    status_emoji: take_optional_string(&mut fields, "status_emoji")?,
                    status_text: take_optional_string(&mut fields, "status_text")?,
                    presence: PresenceStatus::parse(&take_string(&mut fields, "presence")?)
                        .map_err(DesktopCommandError::Core)?,
                    rank: OrgRoleRank::parse(&take_string(&mut fields, "rank")?)
                        .map_err(DesktopCommandError::Core)?,
                };
                kodera_rs::validate_user_profile(&profile).map_err(DesktopCommandError::Core)?;
                Self::UpdateUserProfile {
                    organisation_id,
                    profile,
                }
            }
            "evaluate_channel_iam" => {
                // A conservative local text-channel preview policy, not a caller-authored ACL.
                let policy = ChannelPermissionPolicy {
                    channel_id: take_string(&mut fields, "channel_id")?,
                    category_id: "local-preview".into(),
                    is_voice: false,
                    min_read_rank: OrgRoleRank::Member,
                    min_write_rank: OrgRoleRank::Member,
                    min_manage_rank: OrgRoleRank::Moderator,
                    allow_polls: true,
                    allow_connectors: false,
                };
                let rank = OrgRoleRank::parse(&take_string(&mut fields, "rank")?)
                    .map_err(DesktopCommandError::Core)?;
                Self::EvaluateChannelIam {
                    organisation_id,
                    policy,
                    rank,
                }
            }
            "save_docs_pad" => Self::SaveDocsPad {
                organisation_id,
                pad_id: take_string(&mut fields, "pad_id")?,
                channel_id: take_string(&mut fields, "channel_id")?,
                title: take_string(&mut fields, "title")?,
                markdown_body: take_string(&mut fields, "markdown_body")?,
                editor_handle: take_string(&mut fields, "actor")?,
            },
            "route_deep_link" => Self::RouteDeepLink {
                organisation_id,
                raw_uri: take_string(&mut fields, "raw_uri")?,
            },
            "update_tray_state" => Self::UpdateTrayState {
                organisation_id,
                unread_count: take_integer(&mut fields, "unread_count")?,
                call_state: take_string(&mut fields, "call_state")?,
                muted: take_bool(&mut fields, "muted")?,
                self_host_degraded: take_bool(&mut fields, "self_host_degraded")?,
            },
            "get_tray_state" => Self::GetTrayState { organisation_id },
            "configure_ptt" => Self::ConfigurePtt {
                organisation_id,
                opt_in: take_bool(&mut fields, "opt_in")?,
                raw_chord: take_optional_string(&mut fields, "chord")?,
            },
            "set_ptt_pressed" => Self::SetPttPressed {
                organisation_id,
                pressed: take_bool(&mut fields, "pressed")?,
                now_ms: take_integer(&mut fields, "now_ms")?,
            },
            "get_ptt_state" => Self::GetPttState { organisation_id },
            "validate_keychain_metadata" => Self::ValidateKeychainMetadata {
                organisation_id,
                secret_kind: take_string(&mut fields, "secret_kind")?,
                matrix_user_id: take_string(&mut fields, "matrix_user_id")?,
                device_id: take_string(&mut fields, "device_id")?,
                issued_at_unix_secs: take_integer(&mut fields, "issued_at_unix_secs")?,
                expires_at_unix_secs: take_optional_integer(&mut fields, "expires_at_unix_secs")?,
                raw_secret: take_optional_string(&mut fields, "raw_secret")?,
            },
            "inspect_self_host_health" => Self::InspectSelfHostHealth {
                organisation_id,
                compose_ps_json: take_string(&mut fields, "compose_ps_json")?,
            },
            "restore_window_bounds" => Self::RestoreWindowBounds {
                organisation_id,
                saved_state_json: take_optional_string(&mut fields, "saved_state_json")?,
            },
            "trigger_tray_menu_action" => Self::TriggerTrayMenuAction {
                organisation_id,
                action: take_string(&mut fields, "action")?,
            },
            "set_unread_badge" => Self::SetUnreadBadge {
                organisation_id,
                unread_count: take_integer(&mut fields, "unread_count")?,
            },
            "dispatch_notification" => Self::DispatchNotification {
                organisation_id,
                title: take_string(&mut fields, "title")?,
                body: take_string(&mut fields, "body")?,
                route_uri: take_optional_string(&mut fields, "route_uri")?,
                redact_preview: take_bool(&mut fields, "redact_preview")?,
            },
            "store_keychain_credential" => Self::StoreKeychainCredential {
                organisation_id,
                secret_kind: take_string(&mut fields, "secret_kind")?,
                matrix_user_id: take_string(&mut fields, "matrix_user_id")?,
                device_id: take_string(&mut fields, "device_id")?,
                issued_at_unix_secs: take_integer(&mut fields, "issued_at_unix_secs")?,
                expires_at_unix_secs: take_optional_integer(&mut fields, "expires_at_unix_secs")?,
                raw_secret: take_string(&mut fields, "raw_secret")?,
            },
            "load_keychain_credential" => Self::LoadKeychainCredential {
                organisation_id,
                secret_kind: take_string(&mut fields, "secret_kind")?,
                matrix_user_id: take_string(&mut fields, "matrix_user_id")?,
            },
            "delete_keychain_credential" => Self::DeleteKeychainCredential {
                organisation_id,
                secret_kind: take_string(&mut fields, "secret_kind")?,
                matrix_user_id: take_string(&mut fields, "matrix_user_id")?,
            },
            "begin_oidc_pkce_loopback" => Self::BeginOidcPkceLoopback {
                organisation_id,
                issuer_origin: take_string(&mut fields, "issuer_origin")?,
                client_id: take_string(&mut fields, "client_id")?,
                code_verifier: take_string(&mut fields, "code_verifier")?,
                state: take_string(&mut fields, "state")?,
                loopback_port: take_integer(&mut fields, "loopback_port")?,
            },
            "complete_oidc_pkce_callback" => Self::CompleteOidcPkceCallback {
                organisation_id,
                callback_uri: take_string(&mut fields, "callback_uri")?,
            },
            "self_host_preflight_community" => Self::SelfHostPreflightCommunity {
                organisation_id,
                stack_dir: take_string(&mut fields, "stack_dir")?,
                domain: take_string(&mut fields, "domain")?,
                acme_email: take_string(&mut fields, "acme_email")?,
                tls_mode: take_string(&mut fields, "tls_mode")?,
                http_port: take_integer(&mut fields, "http_port")?,
                https_port: take_integer(&mut fields, "https_port")?,
            },
            "self_host_prepare_community" => Self::SelfHostPrepareCommunity {
                organisation_id,
                stack_dir: take_string(&mut fields, "stack_dir")?,
                domain: take_string(&mut fields, "domain")?,
                acme_email: take_string(&mut fields, "acme_email")?,
                oidc_provider_origin: take_string(&mut fields, "oidc_provider_origin")?,
                tls_mode: take_string(&mut fields, "tls_mode")?,
                http_port: take_integer(&mut fields, "http_port")?,
                https_port: take_integer(&mut fields, "https_port")?,
            },
            "self_host_deploy_community" => Self::SelfHostDeployCommunity {
                organisation_id,
                stack_dir: take_string(&mut fields, "stack_dir")?,
                timeout_ms: take_optional_integer(&mut fields, "timeout_ms")?,
            },
            _ => return Err(DesktopCommandError::InvalidRequest),
        };
        if !fields.is_empty() {
            return Err(DesktopCommandError::InvalidRequest);
        }
        Ok(request)
    }
}

// Values are private and intentionally have no diagnostic formatter: one may hold a raw token.
enum CommandField {
    String(String),
    Integer(u64),
    Boolean(bool),
    Array(Vec<CommandArrayValue>),
}

impl Drop for CommandField {
    fn drop(&mut self) {
        if let Self::String(s) = self {
            s.zeroize();
        }
    }
}

enum CommandArrayValue {
    String(String),
    Integer(u64),
}

impl Drop for CommandArrayValue {
    fn drop(&mut self) {
        if let Self::String(s) = self {
            s.zeroize();
        }
    }
}

fn take_string(
    fields: &mut BTreeMap<String, CommandField>,
    key: &str,
) -> Result<String, DesktopCommandError> {
    match fields.remove(key).as_mut() {
        Some(CommandField::String(value)) => Ok(core::mem::take(value)),
        _ => Err(DesktopCommandError::InvalidRequest),
    }
}

fn take_optional_string(
    fields: &mut BTreeMap<String, CommandField>,
    key: &str,
) -> Result<Option<String>, DesktopCommandError> {
    match fields.remove(key).as_mut() {
        None => Ok(None),
        Some(CommandField::String(value)) => Ok(Some(core::mem::take(value))),
        Some(_) => Err(DesktopCommandError::InvalidRequest),
    }
}

fn take_integer(
    fields: &mut BTreeMap<String, CommandField>,
    key: &str,
) -> Result<u64, DesktopCommandError> {
    match fields.remove(key) {
        Some(CommandField::Integer(value)) => Ok(value),
        _ => Err(DesktopCommandError::InvalidRequest),
    }
}

fn take_optional_integer(
    fields: &mut BTreeMap<String, CommandField>,
    key: &str,
) -> Result<Option<u64>, DesktopCommandError> {
    match fields.remove(key) {
        None => Ok(None),
        Some(CommandField::Integer(value)) => Ok(Some(value)),
        Some(_) => Err(DesktopCommandError::InvalidRequest),
    }
}

fn take_bool(
    fields: &mut BTreeMap<String, CommandField>,
    key: &str,
) -> Result<bool, DesktopCommandError> {
    match fields.remove(key) {
        Some(CommandField::Boolean(value)) => Ok(value),
        _ => Err(DesktopCommandError::InvalidRequest),
    }
}
fn take_strings(
    fields: &mut BTreeMap<String, CommandField>,
    key: &str,
) -> Result<Vec<String>, DesktopCommandError> {
    match fields.remove(key).as_mut() {
        Some(CommandField::Array(values)) => core::mem::take(values)
            .into_iter()
            .map(|mut item| match &mut item {
                CommandArrayValue::String(value) => Ok(core::mem::take(value)),
                CommandArrayValue::Integer(_) => Err(DesktopCommandError::InvalidRequest),
            })
            .collect(),
        _ => Err(DesktopCommandError::InvalidRequest),
    }
}
fn take_integers(
    fields: &mut BTreeMap<String, CommandField>,
    key: &str,
) -> Result<Vec<usize>, DesktopCommandError> {
    match fields.remove(key).as_mut() {
        Some(CommandField::Array(values)) => core::mem::take(values)
            .into_iter()
            .map(|item| match &item {
                CommandArrayValue::Integer(value) => {
                    usize::try_from(*value).map_err(|_| DesktopCommandError::InvalidRequest)
                }
                CommandArrayValue::String(_) => Err(DesktopCommandError::InvalidRequest),
            })
            .collect(),
        _ => Err(DesktopCommandError::InvalidRequest),
    }
}

struct FlatCommandParser<'a> {
    raw: &'a str,
    offset: usize,
}

impl FlatCommandParser<'_> {
    fn parse(&mut self) -> Result<BTreeMap<String, CommandField>, DesktopCommandError> {
        self.whitespace();
        self.expect(b'{')?;
        self.whitespace();
        let mut fields = BTreeMap::new();
        if self.peek() != Some(b'}') {
            loop {
                // The largest schema has ten fields. Bound metadata before allocating a key.
                if fields.len() == 10 {
                    return Err(DesktopCommandError::InvalidRequest);
                }
                let key = self.string()?;
                if fields.contains_key(&key) {
                    return Err(DesktopCommandError::InvalidRequest);
                }
                self.whitespace();
                self.expect(b':')?;
                self.whitespace();
                let value = match self.peek() {
                    Some(b'"') => CommandField::String(self.string()?),
                    Some(b'0'..=b'9') => CommandField::Integer(self.integer()?),
                    Some(b'[') => CommandField::Array(self.array()?),
                    Some(b't') if self.raw[self.offset..].starts_with("true") => {
                        self.offset += 4;
                        CommandField::Boolean(true)
                    }
                    Some(b'f') if self.raw[self.offset..].starts_with("false") => {
                        self.offset += 5;
                        CommandField::Boolean(false)
                    }
                    _ => return Err(DesktopCommandError::InvalidRequest),
                };
                fields.insert(key, value);
                self.whitespace();
                match self.peek() {
                    Some(b',') => {
                        self.offset += 1;
                        self.whitespace();
                    }
                    Some(b'}') => break,
                    _ => return Err(DesktopCommandError::InvalidRequest),
                }
            }
        }
        self.expect(b'}')?;
        self.whitespace();
        if self.offset != self.raw.len() {
            return Err(DesktopCommandError::InvalidRequest);
        }
        Ok(fields)
    }

    /// One bounded scalar array level only. Nested arrays/objects and mixed schema types fail.
    fn array(&mut self) -> Result<Vec<CommandArrayValue>, DesktopCommandError> {
        self.expect(b'[')?;
        self.whitespace();
        let mut values = Vec::new();
        if self.peek() != Some(b']') {
            loop {
                if values.len() == 10 {
                    return Err(DesktopCommandError::InvalidRequest);
                }
                let value = match self.peek() {
                    Some(b'"') => CommandArrayValue::String(self.string()?),
                    Some(b'0'..=b'9') => CommandArrayValue::Integer(self.integer()?),
                    _ => return Err(DesktopCommandError::InvalidRequest),
                };
                values.push(value);
                self.whitespace();
                match self.peek() {
                    Some(b',') => {
                        self.offset += 1;
                        self.whitespace();
                    }
                    Some(b']') => break,
                    _ => return Err(DesktopCommandError::InvalidRequest),
                }
            }
        }
        self.expect(b']')?;
        Ok(values)
    }

    fn peek(&self) -> Option<u8> {
        self.raw.as_bytes().get(self.offset).copied()
    }
    fn whitespace(&mut self) {
        while matches!(self.peek(), Some(b' ' | b'\r' | b'\n' | b'\t')) {
            self.offset += 1;
        }
    }
    fn expect(&mut self, expected: u8) -> Result<(), DesktopCommandError> {
        if self.peek() != Some(expected) {
            return Err(DesktopCommandError::InvalidRequest);
        }
        self.offset += 1;
        Ok(())
    }
    fn integer(&mut self) -> Result<u64, DesktopCommandError> {
        let start = self.offset;
        if self.peek() == Some(b'0') {
            self.offset += 1;
        } else {
            while matches!(self.peek(), Some(b'0'..=b'9')) {
                self.offset += 1;
            }
        }
        self.raw[start..self.offset]
            .parse()
            .map_err(|_| DesktopCommandError::InvalidRequest)
    }
    fn hex_quad(&mut self) -> Result<u32, DesktopCommandError> {
        let mut value = 0;
        for _ in 0..4 {
            let digit = match self.peek() {
                Some(b'0'..=b'9') => u32::from(self.peek().unwrap() - b'0'),
                Some(b'a'..=b'f') => u32::from(self.peek().unwrap() - b'a' + 10),
                Some(b'A'..=b'F') => u32::from(self.peek().unwrap() - b'A' + 10),
                _ => return Err(DesktopCommandError::InvalidRequest),
            };
            self.offset += 1;
            value = (value << 4) | digit;
        }
        Ok(value)
    }
    fn string(&mut self) -> Result<String, DesktopCommandError> {
        self.expect(b'"')?;
        let mut value = String::new();
        loop {
            let next = self.raw[self.offset..]
                .chars()
                .next()
                .ok_or(DesktopCommandError::InvalidRequest)?;
            self.offset += next.len_utf8();
            match next {
                '"' => return Ok(value),
                '\\' => {
                    let escape = self.peek().ok_or(DesktopCommandError::InvalidRequest)?;
                    self.offset += 1;
                    value.push(match escape {
                        b'"' => '"',
                        b'\\' => '\\',
                        b'/' => '/',
                        b'b' => '\u{8}',
                        b'f' => '\u{c}',
                        b'n' => '\n',
                        b'r' => '\r',
                        b't' => '\t',
                        b'u' => {
                            let mut scalar = self.hex_quad()?;
                            if (0xd800..=0xdbff).contains(&scalar) {
                                self.expect(b'\\')?;
                                self.expect(b'u')?;
                                let low = self.hex_quad()?;
                                if !(0xdc00..=0xdfff).contains(&low) {
                                    return Err(DesktopCommandError::InvalidRequest);
                                }
                                scalar = 0x10000 + ((scalar - 0xd800) << 10) + (low - 0xdc00);
                            }
                            char::from_u32(scalar).ok_or(DesktopCommandError::InvalidRequest)?
                        }
                        _ => return Err(DesktopCommandError::InvalidRequest),
                    });
                }
                control if control <= '\u{1f}' => return Err(DesktopCommandError::InvalidRequest),
                other => value.push(other),
            }
        }
    }
}
