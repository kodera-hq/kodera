//! Typed local backend operations. This is not registered Tauri IPC or an authentication layer.

use super::{
    CloudProvider, DeployValidationError, DesktopWorkspaceSession, SelfHostDeploymentPlan,
    SelfHostDeploymentSpec,
};
use kodera_rs::{
    encode_hex, ChannelAccessDecision, ChannelPermissionPolicy, ChannelPollSnapshot, CoreError,
    CoreThemeMode, DocsPadDocument, DocsPadUrl, Ed25519PublicKey, OrgRoleRank, PresenceStatus,
    ProximityHandle, SafetyStatus, ShareableThemePayload, SoundPackId, UserProfile,
    KODERA_MONOGRAM_BG_HEX, MAX_PROXIMITY_QUEUE_CAPACITY,
};
use std::{collections::BTreeMap, fmt};

/// Bound raw UTF-8 requests before parsing or allocating decoded fields.
pub const MAX_IPC_COMMAND_BYTES: usize = 16_384;

/// The proximity routes answer under two names, permanently. The channel was first called
/// `#urgence` and its routes `emergency_*`; a caller written then keeps working. Each legacy name
/// is resolved to its `proximity_*` route before the decoder runs, so both names share one schema,
/// one set of effects and one response. Removing a pair breaks deployed callers: the tests pin all
/// three and fail when one is dropped.
pub const LEGACY_ROUTE_ALIASES: [(&str, &str); 3] = [
    ("emergency_current_beacon", "proximity_current_beacon"),
    ("emergency_member_statuses", "proximity_member_statuses"),
    ("emergency_next_relay_batch", "proximity_next_relay_batch"),
];

fn canonical_route<'a>(command: &'a str, aliases: &[(&'static str, &'static str)]) -> &'a str {
    aliases
        .iter()
        .find(|(legacy, _)| *legacy == command)
        .map_or(command, |(_, canonical)| canonical)
}

/// Every variant is bound to the active organisation, including clear and local planning.
/// Debug and Display intentionally redact the entire request, because a caller can copy a token
/// into a public-looking field. No request value belongs in a diagnostic.
pub enum DesktopCommandRequest {
    CreateChannelPoll {
        organisation_id: String,
        channel_id: String,
        poll_id: String,
        question: String,
        options: Vec<String>,
        allow_multiple: bool,
    },
    VoteChannelPoll {
        organisation_id: String,
        channel_id: String,
        poll_id: String,
        voter_id: String,
        selections: Vec<usize>,
    },
    GetChannelPoll {
        organisation_id: String,
        channel_id: String,
        poll_id: String,
    },
    CloseChannelPoll {
        organisation_id: String,
        channel_id: String,
        poll_id: String,
    },
    RedactIban {
        organisation_id: String,
        raw_iban: String,
    },
    ValidateConnectorPostUrl {
        organisation_id: String,
        raw_url: String,
    },
    PlanSelfHost {
        organisation_id: String,
        provider: CloudProvider,
        region: String,
        fqdn: String,
        acme_email: String,
        raw_token: String,
    },
    ValidateDocsPadUrl {
        organisation_id: String,
        raw_url: String,
    },
    ProximityCurrentBeacon {
        organisation_id: String,
        now_unix_secs: u64,
    },
    ProximityMemberStatuses {
        organisation_id: String,
    },
    ProximityNextRelayBatch {
        organisation_id: String,
        max_frames: usize,
    },
    ClearWorkspaceSession {
        organisation_id: String,
    },
    SetSoundPack {
        organisation_id: String,
        sound_pack: SoundPackId,
    },
    GetSoundPack {
        organisation_id: String,
    },
    SetThemeMode {
        organisation_id: String,
        mode: CoreThemeMode,
    },
    ImportShareableTheme {
        organisation_id: String,
        share_code: String,
    },
    ExportShareableTheme {
        organisation_id: String,
    },
    UpdateUserProfile {
        organisation_id: String,
        profile: UserProfile,
    },
    EvaluateChannelIam {
        organisation_id: String,
        policy: ChannelPermissionPolicy,
        rank: OrgRoleRank,
    },
    SaveDocsPad {
        organisation_id: String,
        pad_id: String,
        channel_id: String,
        title: String,
        markdown_body: String,
        editor_handle: String,
    },
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
    fn from_json_with_aliases(
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
            "plan_self_host" => Self::PlanSelfHost {
                organisation_id,
                provider: match take_string(&mut fields, "provider")?.as_str() {
                    "scaleway" => CloudProvider::Scaleway,
                    "hetzner" => CloudProvider::Hetzner,
                    "hostinger" => CloudProvider::Hostinger,
                    "ovhcloud" => CloudProvider::OvhCloud,
                    _ => return Err(DesktopCommandError::InvalidRequest),
                },
                region: take_string(&mut fields, "region")?,
                fqdn: take_string(&mut fields, "fqdn")?,
                acme_email: take_string(&mut fields, "acme_email")?,
                raw_token: take_string(&mut fields, "raw_token")?,
            },
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
            _ => return Err(DesktopCommandError::InvalidRequest),
        };
        if !fields.is_empty() {
            return Err(DesktopCommandError::InvalidRequest);
        }
        Ok(request)
    }

    fn organisation_id(&self) -> &str {
        match self {
            Self::CreateChannelPoll {
                organisation_id, ..
            }
            | Self::VoteChannelPoll {
                organisation_id, ..
            }
            | Self::GetChannelPoll {
                organisation_id, ..
            }
            | Self::CloseChannelPoll {
                organisation_id, ..
            }
            | Self::RedactIban {
                organisation_id, ..
            }
            | Self::ValidateConnectorPostUrl {
                organisation_id, ..
            }
            | Self::PlanSelfHost {
                organisation_id, ..
            }
            | Self::ValidateDocsPadUrl {
                organisation_id, ..
            }
            | Self::ProximityCurrentBeacon {
                organisation_id, ..
            }
            | Self::ProximityMemberStatuses { organisation_id }
            | Self::ProximityNextRelayBatch {
                organisation_id, ..
            }
            | Self::ClearWorkspaceSession { organisation_id }
            | Self::SetSoundPack {
                organisation_id, ..
            }
            | Self::GetSoundPack { organisation_id }
            | Self::SetThemeMode {
                organisation_id, ..
            }
            | Self::ImportShareableTheme {
                organisation_id, ..
            }
            | Self::ExportShareableTheme { organisation_id }
            | Self::UpdateUserProfile {
                organisation_id, ..
            }
            | Self::EvaluateChannelIam {
                organisation_id, ..
            }
            | Self::SaveDocsPad {
                organisation_id, ..
            } => organisation_id,
        }
    }
}

// Values are private and intentionally have no diagnostic formatter: one may hold a raw token.
enum CommandField {
    String(String),
    Integer(u64),
    Boolean(bool),
    Array(Vec<CommandArrayValue>),
}

enum CommandArrayValue {
    String(String),
    Integer(u64),
}

fn take_string(
    fields: &mut BTreeMap<String, CommandField>,
    key: &str,
) -> Result<String, DesktopCommandError> {
    match fields.remove(key) {
        Some(CommandField::String(value)) => Ok(value),
        _ => Err(DesktopCommandError::InvalidRequest),
    }
}

fn take_optional_string(
    fields: &mut BTreeMap<String, CommandField>,
    key: &str,
) -> Result<Option<String>, DesktopCommandError> {
    match fields.remove(key) {
        None => Ok(None),
        Some(CommandField::String(value)) => Ok(Some(value)),
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
    match fields.remove(key) {
        Some(CommandField::Array(values)) => values
            .into_iter()
            .map(|value| match value {
                CommandArrayValue::String(value) => Ok(value),
                _ => Err(DesktopCommandError::InvalidRequest),
            })
            .collect(),
        _ => Err(DesktopCommandError::InvalidRequest),
    }
}
fn take_integers(
    fields: &mut BTreeMap<String, CommandField>,
    key: &str,
) -> Result<Vec<usize>, DesktopCommandError> {
    match fields.remove(key) {
        Some(CommandField::Array(values)) => values
            .into_iter()
            .map(|value| match value {
                CommandArrayValue::Integer(value) => {
                    usize::try_from(value).map_err(|_| DesktopCommandError::InvalidRequest)
                }
                _ => Err(DesktopCommandError::InvalidRequest),
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

impl fmt::Debug for DesktopCommandRequest {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str("DesktopCommandRequest([REDACTED])")
    }
}

impl fmt::Display for DesktopCommandRequest {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        fmt::Debug::fmt(self, f)
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ProximityMemberStatus {
    pub sender_public_key: Ed25519PublicKey,
    /// The pseudonym to show for this sender. Derived from the sender key; never a name.
    pub sender_handle: ProximityHandle,
    pub status: SafetyStatus,
    pub text: String,
    pub timestamp_ms: u64,
}

/// Closed errors carry no parser text, input fragments, tokens or deployment spec values.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum DesktopCommandError {
    RequestTooLarge,
    InvalidRequest,
    Core(CoreError),
    Deployment(DeployValidationError),
    SecretInPublicPlan,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum DesktopCommandResponse {
    ChannelPoll(ChannelPollSnapshot),
    RedactedIban(String),
    ConnectorPostUrl(String),
    SelfHostPlan(SelfHostDeploymentPlan),
    DocsPadUrl(DocsPadUrl),
    ProximityBeacon {
        bytes: [u8; 8],
        hex: String,
    },
    ProximityMemberStatuses(Vec<ProximityMemberStatus>),
    ProximityRelayBatch(Vec<Vec<u8>>),
    SoundPack(SoundPackId),
    ThemeMode {
        mode: CoreThemeMode,
        monogram_bg_hex: &'static str,
    },
    ShareableTheme(ShareableThemePayload),
    ShareableThemeCode(String),
    UserProfile(UserProfile),
    ChannelAccess(ChannelAccessDecision),
    DocsPad(DocsPadDocument),
    WorkspaceSessionCleared,
    Error(DesktopCommandError),
}

impl fmt::Display for DesktopCommandResponse {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        fmt::Debug::fmt(self, f)
    }
}

fn public_plan_exposes_token(plan: &SelfHostDeploymentPlan, token: &str) -> bool {
    // Domain normalization can case-fold token-shaped input. Check the actual returned fields,
    // independently of how a formatter escapes them, and diagnostics as a defensive backstop.
    let token = token.to_ascii_lowercase();
    let exposes = |value: &str| value.to_ascii_lowercase().contains(&token);
    exposes(&plan.region)
        || plan.required_dns.iter().any(|record| exposes(&record.fqdn))
        || plan.https_origins.iter().any(|origin| exposes(origin))
        || plan
            .community_public_config
            .iter()
            .any(|(key, value)| exposes(key) || exposes(value))
        || exposes(&format!("{plan:?}"))
}

impl DesktopWorkspaceSession {
    /// Bounded command-only JSON admission. Parsing/schema errors carry no input text and have
    /// no side effects; this method neither registers JS IPC nor establishes caller identity.
    pub fn dispatch_command(&mut self, raw_json: &str) -> DesktopCommandResponse {
        self.dispatch_command_with_aliases(raw_json, &LEGACY_ROUTE_ALIASES)
    }

    fn dispatch_command_with_aliases(
        &mut self,
        raw_json: &str,
        aliases: &[(&'static str, &'static str)],
    ) -> DesktopCommandResponse {
        match DesktopCommandRequest::from_json_with_aliases(raw_json, aliases) {
            Ok(request) => self.execute_command(request),
            Err(error) => DesktopCommandResponse::Error(error),
        }
    }

    fn execute_command(&mut self, request: DesktopCommandRequest) -> DesktopCommandResponse {
        if let Err(error) = self.check_organisation(request.organisation_id()) {
            return DesktopCommandResponse::Error(DesktopCommandError::Core(error));
        }
        let result = match request {
            DesktopCommandRequest::CreateChannelPoll {
                organisation_id,
                channel_id,
                poll_id,
                question,
                options,
                allow_multiple,
            } => self
                .create_channel_poll(
                    &organisation_id,
                    &channel_id,
                    &poll_id,
                    &question,
                    &options,
                    allow_multiple,
                )
                .map(DesktopCommandResponse::ChannelPoll)
                .map_err(DesktopCommandError::Core),
            DesktopCommandRequest::VoteChannelPoll {
                organisation_id,
                channel_id,
                poll_id,
                voter_id,
                selections,
            } => self
                .vote_channel_poll(
                    &organisation_id,
                    &channel_id,
                    &poll_id,
                    &voter_id,
                    &selections,
                )
                .map(DesktopCommandResponse::ChannelPoll)
                .map_err(DesktopCommandError::Core),
            DesktopCommandRequest::GetChannelPoll {
                organisation_id,
                channel_id,
                poll_id,
            } => self
                .channel_poll(&organisation_id, &channel_id, &poll_id)
                .map(DesktopCommandResponse::ChannelPoll)
                .map_err(DesktopCommandError::Core),
            DesktopCommandRequest::CloseChannelPoll {
                organisation_id,
                channel_id,
                poll_id,
            } => self
                .close_channel_poll(&organisation_id, &channel_id, &poll_id)
                .map(DesktopCommandResponse::ChannelPoll)
                .map_err(DesktopCommandError::Core),
            DesktopCommandRequest::RedactIban {
                organisation_id,
                raw_iban,
            } => self
                .redact_connector_iban(&organisation_id, &raw_iban)
                .map(DesktopCommandResponse::RedactedIban)
                .map_err(DesktopCommandError::Core),
            DesktopCommandRequest::ValidateConnectorPostUrl {
                organisation_id,
                raw_url,
            } => self
                .validate_connector_post_url(&organisation_id, &raw_url)
                .map(DesktopCommandResponse::ConnectorPostUrl)
                .map_err(DesktopCommandError::Core),
            DesktopCommandRequest::PlanSelfHost {
                provider,
                region,
                fqdn,
                acme_email,
                raw_token,
                ..
            } => (|| {
                let spec = SelfHostDeploymentSpec::validate(
                    provider,
                    &region,
                    &fqdn,
                    &acme_email,
                    &raw_token,
                )
                .map_err(DesktopCommandError::Deployment)?;
                let plan = SelfHostDeploymentPlan::from_spec(&spec)
                    .map_err(DesktopCommandError::Deployment)?;
                // Public fields are user-controlled too. Reject a token copied into any returned
                // metadata rather than returning a redacted, invalid deployment plan.
                if public_plan_exposes_token(&plan, spec.token.expose_for_provider_call()) {
                    return Err(DesktopCommandError::SecretInPublicPlan);
                }
                Ok(DesktopCommandResponse::SelfHostPlan(plan))
            })(),
            DesktopCommandRequest::ValidateDocsPadUrl {
                organisation_id,
                raw_url,
            } => self
                .validate_docs_pad_url(&organisation_id, &raw_url)
                .map(DesktopCommandResponse::DocsPadUrl)
                .map_err(DesktopCommandError::Core),
            DesktopCommandRequest::ProximityCurrentBeacon {
                organisation_id,
                now_unix_secs,
            } => self
                .current_beacon(&organisation_id, now_unix_secs)
                .map(|bytes| DesktopCommandResponse::ProximityBeacon {
                    hex: encode_hex(&bytes),
                    bytes,
                })
                .map_err(DesktopCommandError::Core),
            DesktopCommandRequest::ProximityMemberStatuses { organisation_id } => self
                .member_statuses(&organisation_id)
                .map(|members| {
                    DesktopCommandResponse::ProximityMemberStatuses(
                        members
                            .into_iter()
                            .map(|(sender_public_key, status, text, timestamp_ms)| {
                                ProximityMemberStatus {
                                    sender_handle: ProximityHandle::generated(&sender_public_key),
                                    sender_public_key,
                                    status,
                                    text,
                                    timestamp_ms,
                                }
                            })
                            .collect(),
                    )
                })
                .map_err(DesktopCommandError::Core),
            DesktopCommandRequest::ProximityNextRelayBatch {
                organisation_id,
                max_frames,
            } => self
                .next_relay_batch(
                    &organisation_id,
                    max_frames.min(MAX_PROXIMITY_QUEUE_CAPACITY),
                )
                .map(DesktopCommandResponse::ProximityRelayBatch)
                .map_err(DesktopCommandError::Core),
            DesktopCommandRequest::ClearWorkspaceSession { .. } => {
                self.clear_session();
                Ok(DesktopCommandResponse::WorkspaceSessionCleared)
            }
            DesktopCommandRequest::SetSoundPack {
                organisation_id,
                sound_pack,
            } => self
                .set_sound_pack(&organisation_id, sound_pack)
                .map(|()| DesktopCommandResponse::SoundPack(sound_pack))
                .map_err(DesktopCommandError::Core),
            DesktopCommandRequest::GetSoundPack { organisation_id } => self
                .sound_pack(&organisation_id)
                .map(DesktopCommandResponse::SoundPack)
                .map_err(DesktopCommandError::Core),
            DesktopCommandRequest::SetThemeMode {
                organisation_id,
                mode,
            } => self
                .set_theme_mode(&organisation_id, mode)
                .map(|mode| DesktopCommandResponse::ThemeMode {
                    mode,
                    monogram_bg_hex: KODERA_MONOGRAM_BG_HEX,
                })
                .map_err(DesktopCommandError::Core),
            DesktopCommandRequest::ImportShareableTheme {
                organisation_id,
                share_code,
            } => self
                .import_shareable_theme(&organisation_id, &share_code)
                .map(DesktopCommandResponse::ShareableTheme)
                .map_err(DesktopCommandError::Core),
            DesktopCommandRequest::ExportShareableTheme { organisation_id } => self
                .export_shareable_theme(&organisation_id)
                .map(DesktopCommandResponse::ShareableThemeCode)
                .map_err(DesktopCommandError::Core),
            DesktopCommandRequest::UpdateUserProfile {
                organisation_id,
                profile,
            } => self
                .update_user_profile(&organisation_id, profile)
                .map(DesktopCommandResponse::UserProfile)
                .map_err(DesktopCommandError::Core),
            DesktopCommandRequest::EvaluateChannelIam {
                organisation_id,
                policy,
                rank,
            } => self
                .evaluate_channel_iam(&organisation_id, rank, &policy)
                .map(DesktopCommandResponse::ChannelAccess)
                .map_err(DesktopCommandError::Core),
            DesktopCommandRequest::SaveDocsPad {
                organisation_id,
                pad_id,
                channel_id,
                title,
                markdown_body,
                editor_handle,
            } => self
                .save_docs_pad(
                    &organisation_id,
                    &pad_id,
                    &channel_id,
                    &title,
                    &markdown_body,
                    &editor_handle,
                )
                .map(DesktopCommandResponse::DocsPad)
                .map_err(DesktopCommandError::Core),
        };
        result.unwrap_or_else(DesktopCommandResponse::Error)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use kodera_rs::{
        hmac_sha256, DeviceIdentitySigner, Ed25519Signature, SignatureVerifier, UuidV7,
    };
    use std::collections::HashSet;

    const ORG: &str = "019a5e62-6ca0-7303-8303-030303030303";
    const OTHER_ORG: &str = "019a5e62-6ca0-7303-8303-030303030304";
    const TOKEN: &str = "fixture-token-never-reflect";

    struct Signer(u8);
    impl DeviceIdentitySigner for Signer {
        fn public_key(&self) -> Ed25519PublicKey {
            [self.0; 32]
        }
        fn sign(&self, message: &[u8]) -> Result<Ed25519Signature, CoreError> {
            let digest = hmac_sha256(&[self.0; 32], message);
            let mut signature = [0; 64];
            signature[..32].copy_from_slice(&digest);
            signature[32..].copy_from_slice(&digest);
            Ok(signature)
        }
    }
    impl SignatureVerifier for Signer {
        fn verify(
            &self,
            public_key: &Ed25519PublicKey,
            message: &[u8],
            signature: &Ed25519Signature,
        ) -> Result<(), CoreError> {
            if public_key != &self.public_key() || signature != &self.sign(message)? {
                return Err(CoreError::InvalidSignature);
            }
            Ok(())
        }
    }

    fn session() -> DesktopWorkspaceSession {
        DesktopWorkspaceSession::new(ORG, [0x42; 32], HashSet::from([[1; 32], [2; 32]]), 128)
            .unwrap()
    }
    fn plan_request(org: &str, token: &str) -> DesktopCommandRequest {
        DesktopCommandRequest::PlanSelfHost {
            organisation_id: org.to_owned(),
            provider: CloudProvider::Scaleway,
            region: "fr-par-1".to_owned(),
            fqdn: "chat.example.org".to_owned(),
            acme_email: "ops@example.org".to_owned(),
            raw_token: token.to_owned(),
        }
    }
    fn populate(session: &mut DesktopWorkspaceSession, sender: u8, time: u64) {
        let signer = Signer(sender);
        session
            .create_local_checkin(
                ORG,
                UuidV7::from_parts(time, [sender; 10]),
                SafetyStatus::Safe,
                "Local fixture",
                &signer,
                &signer,
            )
            .unwrap();
    }

    #[test]
    fn plan_request_and_success_response_do_not_reflect_token() {
        let request = plan_request(ORG, TOKEN);
        assert!(!format!("{request:?}").contains(TOKEN));
        assert!(!format!("{request}").contains(TOKEN));
        let response = session().execute_command(request);
        assert!(matches!(response, DesktopCommandResponse::SelfHostPlan(_)));
        assert!(!format!("{response:?}").contains(TOKEN));
        assert!(!format!("{response}").contains(TOKEN));
    }

    #[test]
    fn public_field_token_alias_and_trimmed_alias_are_refused() {
        for token in [
            "sensitive.example.org",
            "  sensitive.example.org  ",
            "SENSITIVE.EXAMPLE.ORG",
            "  SENSITIVE.EXAMPLE.ORG  ",
        ] {
            let request = DesktopCommandRequest::PlanSelfHost {
                organisation_id: ORG.to_owned(),
                provider: CloudProvider::Hetzner,
                region: "fsn1".to_owned(),
                fqdn: token.trim().to_owned(),
                acme_email: "ops@example.org".to_owned(),
                raw_token: token.to_owned(),
            };
            assert!(!format!("{request:?}").contains("sensitive.example.org"));
            let response = session().execute_command(request);
            assert_eq!(
                response,
                DesktopCommandResponse::Error(DesktopCommandError::SecretInPublicPlan)
            );
            assert!(!format!("{response:?}").contains("sensitive.example.org"));
        }
    }

    #[test]
    fn invalid_plan_returns_only_closed_error_and_preserves_session() {
        let mut session = session();
        let mut request = plan_request(ORG, TOKEN);
        if let DesktopCommandRequest::PlanSelfHost { acme_email, .. } = &mut request {
            *acme_email = TOKEN.to_owned();
        }
        let response = session.execute_command(request);
        assert_eq!(
            response,
            DesktopCommandResponse::Error(DesktopCommandError::Deployment(
                DeployValidationError::InvalidAdminEmail
            ))
        );
        assert!(!format!("{response:?}").contains(TOKEN));
        assert_eq!(session.sound_pack(ORG), Ok(SoundPackId::Givre));
    }

    #[test]
    fn all_typed_commands_are_organisation_fenced_before_any_effect() {
        let mut session = session();
        populate(&mut session, 1, 1);
        let commands = [
            plan_request(OTHER_ORG, TOKEN),
            DesktopCommandRequest::ValidateDocsPadUrl {
                organisation_id: OTHER_ORG.to_owned(),
                raw_url: "https://docs.example.org/docs/one".to_owned(),
            },
            DesktopCommandRequest::ProximityCurrentBeacon {
                organisation_id: OTHER_ORG.to_owned(),
                now_unix_secs: 1,
            },
            DesktopCommandRequest::ProximityMemberStatuses {
                organisation_id: OTHER_ORG.to_owned(),
            },
            DesktopCommandRequest::ProximityNextRelayBatch {
                organisation_id: OTHER_ORG.to_owned(),
                max_frames: usize::MAX,
            },
            DesktopCommandRequest::ClearWorkspaceSession {
                organisation_id: OTHER_ORG.to_owned(),
            },
            DesktopCommandRequest::SetSoundPack {
                organisation_id: OTHER_ORG.to_owned(),
                sound_pack: SoundPackId::Silent,
            },
            DesktopCommandRequest::GetSoundPack {
                organisation_id: OTHER_ORG.to_owned(),
            },
        ];
        for request in commands {
            assert_eq!(
                session.execute_command(request),
                DesktopCommandResponse::Error(DesktopCommandError::Core(
                    CoreError::OrganisationMismatch
                ))
            );
            assert_eq!(session.sound_pack(ORG), Ok(SoundPackId::Givre));
            assert_eq!(session.member_statuses(ORG).unwrap().len(), 1);
        }
        assert_eq!(session.next_relay_batch(ORG, 1).unwrap().len(), 1);
    }

    #[test]
    fn docs_command_requires_provisioned_host_and_returns_canonical_metadata() {
        let mut session = session();
        let make = || DesktopCommandRequest::ValidateDocsPadUrl {
            organisation_id: ORG.to_owned(),
            raw_url: "https://docs.example.org:443/pads/one".to_owned(),
        };
        assert_eq!(
            session.execute_command(make()),
            DesktopCommandResponse::Error(DesktopCommandError::Core(
                CoreError::TransportUnavailable
            ))
        );
        session
            .configure_docs_host(ORG, Some("docs.example.org"))
            .unwrap();
        let DesktopCommandResponse::DocsPadUrl(url) = session.execute_command(make()) else {
            panic!("expected metadata")
        };
        assert_eq!(url.as_str(), "https://docs.example.org/pads/one");
    }

    #[test]
    fn beacon_response_has_same_bytes_and_canonical_hex() {
        let response = session().execute_command(DesktopCommandRequest::ProximityCurrentBeacon {
            organisation_id: ORG.to_owned(),
            now_unix_secs: 1_762_520_100,
        });
        assert_eq!(
            response,
            DesktopCommandResponse::ProximityBeacon {
                bytes: [0x1b, 0xe3, 0x96, 0x76, 0x37, 0xeb, 0xb0, 0xea],
                hex: "1be3967637ebb0ea".to_owned(),
            }
        );
    }

    #[test]
    fn member_status_response_is_sorted_and_preserves_verified_metadata() {
        let mut session = session();
        populate(&mut session, 2, 2);
        populate(&mut session, 1, 1);
        let DesktopCommandResponse::ProximityMemberStatuses(statuses) =
            session.execute_command(DesktopCommandRequest::ProximityMemberStatuses {
                organisation_id: ORG.to_owned(),
            })
        else {
            panic!("expected roster")
        };
        assert_eq!(
            statuses
                .iter()
                .map(|m| m.sender_public_key)
                .collect::<Vec<_>>(),
            vec![[1; 32], [2; 32]]
        );
        assert_eq!(statuses[0].timestamp_ms, 1);
        assert_eq!(statuses[0].text, "Local fixture");
    }

    #[test]
    fn relay_batch_zero_and_large_limits_are_bounded_and_drain_once() {
        let mut session = session();
        populate(&mut session, 1, 1);
        populate(&mut session, 2, 2);
        let request = |max_frames| DesktopCommandRequest::ProximityNextRelayBatch {
            organisation_id: ORG.to_owned(),
            max_frames,
        };
        assert_eq!(
            session.execute_command(request(0)),
            DesktopCommandResponse::ProximityRelayBatch(vec![])
        );
        let DesktopCommandResponse::ProximityRelayBatch(frames) =
            session.execute_command(request(usize::MAX))
        else {
            panic!("expected frames")
        };
        assert_eq!(frames.len(), 2);
        assert_eq!(
            session.execute_command(request(1)),
            DesktopCommandResponse::ProximityRelayBatch(vec![])
        );
    }

    #[test]
    fn sound_pack_commands_round_trip_without_audio_activation() {
        let mut session = session();
        for sound_pack in [
            SoundPackId::Givre,
            SoundPackId::Cristal,
            SoundPackId::Atelier,
            SoundPackId::Arcade8Bit,
            SoundPackId::Glitch404,
            SoundPackId::Silent,
        ] {
            assert_eq!(
                session.execute_command(DesktopCommandRequest::SetSoundPack {
                    organisation_id: ORG.to_owned(),
                    sound_pack
                }),
                DesktopCommandResponse::SoundPack(sound_pack)
            );
            assert_eq!(
                session.execute_command(DesktopCommandRequest::GetSoundPack {
                    organisation_id: ORG.to_owned()
                }),
                DesktopCommandResponse::SoundPack(sound_pack)
            );
        }
    }

    #[test]
    fn clear_removes_all_state_and_later_commands_fail_closed() {
        let mut session = session();
        populate(&mut session, 1, 1);
        session
            .configure_docs_host(ORG, Some("docs.example.org"))
            .unwrap();
        session.set_sound_pack(ORG, SoundPackId::Silent).unwrap();
        assert_eq!(
            session.execute_command(DesktopCommandRequest::ClearWorkspaceSession {
                organisation_id: ORG.to_owned()
            }),
            DesktopCommandResponse::WorkspaceSessionCleared
        );
        assert!(
            session.organisation_id.is_none()
                && session.proximity.is_none()
                && session.allowed_docs_host.is_none()
                && session.extension_webhooks.is_none()
                && session.sound_pack.is_none()
        );
        assert_eq!(
            session.execute_command(DesktopCommandRequest::GetSoundPack {
                organisation_id: ORG.to_owned()
            }),
            DesktopCommandResponse::Error(DesktopCommandError::Core(
                CoreError::TransportUnavailable
            ))
        );
        assert_eq!(
            session.execute_command(DesktopCommandRequest::ClearWorkspaceSession {
                organisation_id: ORG.to_owned()
            }),
            DesktopCommandResponse::Error(DesktopCommandError::Core(
                CoreError::TransportUnavailable
            ))
        );
    }

    #[test]
    fn organisation_switch_resets_sound_and_old_clear_cannot_end_replacement() {
        let mut session = session();
        session.set_sound_pack(ORG, SoundPackId::Silent).unwrap();
        session
            .switch_organisation(OTHER_ORG, [0x43; 32], HashSet::new(), 2)
            .unwrap();
        assert_eq!(session.sound_pack(OTHER_ORG), Ok(SoundPackId::Givre));
        assert_eq!(
            session.execute_command(DesktopCommandRequest::ClearWorkspaceSession {
                organisation_id: ORG.to_owned()
            }),
            DesktopCommandResponse::Error(DesktopCommandError::Core(
                CoreError::OrganisationMismatch
            ))
        );
        assert_eq!(session.sound_pack(OTHER_ORG), Ok(SoundPackId::Givre));
        assert!(session
            .switch_organisation("invalid", [0; 32], HashSet::new(), 2)
            .is_err());
        assert!(session.sound_pack.is_none());
    }

    fn json(command: &str, fields: &str) -> String {
        format!(r#"{{"command":"{command}","organisation_id":"{ORG}"{fields}}}"#)
    }

    #[test]
    fn raw_json_routes_all_operations_and_never_reflects_plan_token() {
        let mut session = session();
        let plan = json(
            "plan_self_host",
            &format!(
                r#", "provider":"scaleway","region":"fr-par-1","fqdn":"chat.example.org","acme_email":"ops@example.org","raw_token":"{TOKEN}""#
            ),
        );
        let response = session.dispatch_command(&plan);
        assert!(matches!(response, DesktopCommandResponse::SelfHostPlan(_)));
        assert!(!format!("{response:?}").contains(TOKEN));
        session
            .configure_docs_host(ORG, Some("docs.example.org"))
            .unwrap();
        assert!(matches!(
            session.dispatch_command(&json(
                "validate_docs_pad_url",
                r#", "raw_url":"https://docs.example.org/docs/one""#
            )),
            DesktopCommandResponse::DocsPadUrl(_)
        ));
        assert!(matches!(
            session.dispatch_command(&json(
                "proximity_current_beacon",
                r#", "now_unix_secs":1762520100"#
            )),
            DesktopCommandResponse::ProximityBeacon { .. }
        ));
        assert_eq!(
            session.dispatch_command(&json("proximity_member_statuses", "")),
            DesktopCommandResponse::ProximityMemberStatuses(vec![])
        );
        assert_eq!(
            session.dispatch_command(&json("proximity_next_relay_batch", r#", "max_frames":128"#)),
            DesktopCommandResponse::ProximityRelayBatch(vec![])
        );
        assert_eq!(
            session.dispatch_command(&json("set_sound_pack", r#", "sound_pack":"404""#)),
            DesktopCommandResponse::SoundPack(SoundPackId::Glitch404)
        );
        assert_eq!(
            session.dispatch_command(&json("get_sound_pack", "")),
            DesktopCommandResponse::SoundPack(SoundPackId::Glitch404)
        );
        assert_eq!(
            session.dispatch_command(&json("clear_workspace_session", "")),
            DesktopCommandResponse::WorkspaceSessionCleared
        );
        assert!(session.organisation_id().is_none());
    }

    #[test]
    fn json_unknown_duplicate_and_escaped_duplicate_fields_never_clear_or_drain() {
        let mut session = session();
        populate(&mut session, 1, 1);
        for input in [
            json(
                "clear_workspace_session",
                r#", "unknown":"fixture-sensitive-field""#,
            ),
            json(
                "proximity_next_relay_batch",
                r#", "max_frames":128,"raw_token":"fixture-sensitive-field""#,
            ),
            json("clear_workspace_session", r#", "command":"get_sound_pack""#),
            json(
                "clear_workspace_session",
                &format!(r#", "organisation\u005fid":"{OTHER_ORG}""#),
            ),
        ] {
            assert_eq!(
                session.dispatch_command(&input),
                DesktopCommandResponse::Error(DesktopCommandError::InvalidRequest)
            );
            assert_eq!(session.sound_pack(ORG), Ok(SoundPackId::Givre));
            assert_eq!(session.member_statuses(ORG).unwrap().len(), 1);
        }
        assert_eq!(session.next_relay_batch(ORG, 128).unwrap().len(), 1);
    }

    #[test]
    fn json_byte_bound_is_inclusive_and_checked_before_parsing() {
        let mut session = session();
        let request = json("get_sound_pack", "");
        let exact = request.clone() + &" ".repeat(MAX_IPC_COMMAND_BYTES - request.len());
        assert_eq!(exact.len(), MAX_IPC_COMMAND_BYTES);
        assert_eq!(
            session.dispatch_command(&exact),
            DesktopCommandResponse::SoundPack(SoundPackId::Givre)
        );
        assert_eq!(
            session.dispatch_command(&(exact + " ")),
            DesktopCommandResponse::Error(DesktopCommandError::RequestTooLarge)
        );
        assert_eq!(
            session.dispatch_command(&"é".repeat(MAX_IPC_COMMAND_BYTES / 2 + 1)),
            DesktopCommandResponse::Error(DesktopCommandError::RequestTooLarge)
        );
        assert_eq!(session.sound_pack(ORG), Ok(SoundPackId::Givre));
    }

    #[test]
    fn json_integer_grammar_refuses_coercions_and_unsigned_overflow() {
        let mut session = session();
        for number in [
            "-1",
            "+1",
            "01",
            "1.0",
            "1e0",
            "18446744073709551616",
            "null",
            "false",
            r#""128""#,
        ] {
            assert_eq!(
                session.dispatch_command(&json(
                    "proximity_next_relay_batch",
                    &format!(",\"max_frames\":{number}")
                )),
                DesktopCommandResponse::Error(DesktopCommandError::InvalidRequest),
                "{number}"
            );
        }
        assert!(matches!(
            session.dispatch_command(&json(
                "proximity_current_beacon",
                ",\"now_unix_secs\":18446744073709551615"
            )),
            DesktopCommandResponse::ProximityBeacon { .. }
        ));
    }

    #[test]
    fn json_strings_decode_standard_escapes_and_surrogate_pairs_without_diagnostic_leaks() {
        let escaped = json(
            "plan_self_host",
            r#", "provider":"scaleway","region":"fr-par-1","fqdn":"chat.example.org","acme_email":"ops@example.org","raw_token":"quote: \" slash: \\ emoji: \ud83e\udded""#,
        );
        let request = DesktopCommandRequest::from_json(&escaped).unwrap();
        assert_eq!(format!("{request:?}"), "DesktopCommandRequest([REDACTED])");
        let DesktopCommandRequest::PlanSelfHost { raw_token, .. } = request else {
            panic!("expected plan")
        };
        assert_eq!(raw_token, "quote: \" slash: \\ emoji: 🧭");
        assert_eq!(
            session().dispatch_command(&json("set_sound_pack", r#", "sound_pack":"\u0067ivre""#)),
            DesktopCommandResponse::SoundPack(SoundPackId::Givre)
        );
    }

    #[test]
    fn malformed_json_and_deep_inputs_cannot_mutate_workspace() {
        let mut session = session();
        let mut invalid = vec![
            "".to_owned(),
            "{}".to_owned(),
            "[]".to_owned(),
            "null".to_owned(),
            json("get_sound_pack", "") + "{}",
            json("get_sound_pack", ","),
            json("get_sound_pack", r#", "nested":{"a":1}"#),
            json("get_sound_pack", r#", "array":[1,2,3]"#),
        ];
        invalid.push("{\"command\":".to_owned() + &"[".repeat(4000) + &"]".repeat(4000) + "}");
        for bad_escape in [
            r#"\ud800"#,
            r#"\udfff"#,
            r#"\ud800\u0041"#,
            r#"\u0"#,
            r#"\q"#,
        ] {
            // Use an otherwise valid schema so semantic command rejection cannot mask a
            // decoder that accidentally accepts malformed string values.
            invalid.push(json("plan_self_host", &format!(r#", "provider":"scaleway","region":"fr-par-1","fqdn":"chat.example.org","acme_email":"ops@example.org","raw_token":"{bad_escape}""#)));
        }
        for input in invalid {
            assert!(matches!(
                DesktopCommandRequest::from_json(&input),
                Err(DesktopCommandError::InvalidRequest)
            ));
            assert_eq!(
                session.dispatch_command(&input),
                DesktopCommandResponse::Error(DesktopCommandError::InvalidRequest)
            );
            assert_eq!(session.sound_pack(ORG), Ok(SoundPackId::Givre));
        }
    }

    #[test]
    fn missing_fields_wrong_types_unknown_commands_and_legacy_packs_are_closed_errors() {
        let mut session = session();
        for input in [
            r#"{"command":"clear_workspace_session"}"#.to_owned(),
            json("unknown", ""),
            json("set_sound_pack", ""),
            json("set_sound_pack", r#", "sound_pack":123"#),
            json("get_sound_pack", r#", "extra":"fixture-private-input""#),
        ] {
            let response = session.dispatch_command(&input);
            assert_eq!(
                response,
                DesktopCommandResponse::Error(DesktopCommandError::InvalidRequest)
            );
            assert!(!format!("{response:?}").contains("fixture-private-input"));
        }
        for slug in [
            "kodera-givre",
            "feutre",
            "impulsion",
            "8bit-atelier",
            "silencieux",
        ] {
            assert_eq!(
                session.dispatch_command(&json(
                    "set_sound_pack",
                    &format!(",\"sound_pack\":\"{slug}\"")
                )),
                DesktopCommandResponse::Error(DesktopCommandError::Core(
                    CoreError::InvalidSoundPack
                ))
            );
        }
    }

    fn poll_request(command: &str, fields: &str) -> String {
        json(
            command,
            &format!(r#", "channel_id":"text", "poll_id":"poll"{fields}"#),
        )
    }
    fn create_poll_json() -> String {
        poll_request(
            "create_channel_poll",
            r#", "question":"Choose?", "options":["One","Two"],"allow_multiple":true"#,
        )
    }
    #[test]
    fn poll_json_create_vote_read_close_routes_are_transactional_and_scoped() {
        let mut state = session();
        let DesktopCommandResponse::ChannelPoll(empty) =
            state.dispatch_command(&create_poll_json())
        else {
            panic!("expected poll")
        };
        assert_eq!(empty.total_votes, 0);
        let vote = poll_request(
            "vote_channel_poll",
            &format!(r#", "voter_id":"{ORG}","selections":[0,1]"#),
        );
        let DesktopCommandResponse::ChannelPoll(voted) = state.dispatch_command(&vote) else {
            panic!("expected vote")
        };
        assert_eq!(voted.total_votes, 1);
        assert_eq!(
            voted
                .options
                .iter()
                .map(|o| o.percentage)
                .collect::<Vec<_>>(),
            [100, 100]
        );
        assert_eq!(
            state.dispatch_command(&poll_request("get_channel_poll", "")),
            DesktopCommandResponse::ChannelPoll(voted.clone())
        );
        let wrong = vote.replace(ORG, OTHER_ORG);
        assert_eq!(
            state.dispatch_command(&wrong),
            DesktopCommandResponse::Error(DesktopCommandError::Core(
                CoreError::OrganisationMismatch
            ))
        );
        assert_eq!(state.channel_poll(ORG, "text", "poll").unwrap(), voted);
        let DesktopCommandResponse::ChannelPoll(closed) =
            state.dispatch_command(&poll_request("close_channel_poll", ""))
        else {
            panic!("expected closed poll")
        };
        assert!(closed.is_closed);
        assert_eq!(
            state.dispatch_command(&vote),
            DesktopCommandResponse::Error(DesktopCommandError::Core(CoreError::PollClosed))
        );
        assert_eq!(
            state.dispatch_command(&create_poll_json()),
            DesktopCommandResponse::Error(DesktopCommandError::Core(CoreError::PollExists))
        );
        assert_eq!(state.channel_poll(ORG, "text", "poll").unwrap(), closed);
    }
    #[test]
    fn poll_json_extensions_are_bounded_and_old_command_schemas_do_not_widen() {
        let mut state = session();
        state.dispatch_command(&create_poll_json());
        let original = state.channel_poll(ORG, "text", "poll").unwrap();
        let invalid = [
            create_poll_json().replace("true", "1"),
            create_poll_json().replace("true", "truefalse"),
            create_poll_json().replace(r#"["One","Two"]"#, r#"["One",2]"#),
            create_poll_json().replace(r#"["One","Two"]"#, r#"[["One"],"Two"]"#),
            create_poll_json().replace(r#"["One","Two"]"#, r#"["One","Two",]"#),
            create_poll_json().replace(
                r#"["One","Two"]"#,
                &format!("[{}]", (0..11).map(|_| "0").collect::<Vec<_>>().join(",")),
            ),
            poll_request("close_channel_poll", r#", "extra":[0]"#),
            poll_request(
                "vote_channel_poll",
                &format!(r#", "voter_id":"{ORG}", "selections":[true]"#),
            ),
            json("proximity_next_relay_batch", r#", "max_frames":[1]"#),
            json("get_sound_pack", r#", "extra":false"#),
        ];
        for input in invalid {
            assert_eq!(
                state.dispatch_command(&input),
                DesktopCommandResponse::Error(DesktopCommandError::InvalidRequest),
                "schema refusal"
            );
            assert_eq!(state.channel_poll(ORG, "text", "poll").unwrap(), original);
        }
        assert_eq!(
            state.dispatch_command(&poll_request(
                "vote_channel_poll",
                &format!(r#", "voter_id":"{ORG}","selections":[0,0]"#)
            )),
            DesktopCommandResponse::Error(DesktopCommandError::Core(CoreError::InvalidPollVote))
        );
        let huge = create_poll_json() + &" ".repeat(MAX_IPC_COMMAND_BYTES);
        assert_eq!(
            state.dispatch_command(&huge),
            DesktopCommandResponse::Error(DesktopCommandError::RequestTooLarge)
        );
    }
    #[test]
    fn poll_session_capacity_scope_and_teardown_prevent_replacement_leaks() {
        let mut state = session();
        for index in 0..32 {
            state
                .create_channel_poll(
                    ORG,
                    "text",
                    &format!("poll-{index}"),
                    "Question?",
                    &["One".into(), "Two".into()],
                    false,
                )
                .unwrap();
        }
        let original = state.channel_poll(ORG, "text", "poll-0").unwrap();
        assert_eq!(
            state.create_channel_poll(
                ORG,
                "text",
                "overflow",
                "Question?",
                &["One".into(), "Two".into()],
                false
            ),
            Err(CoreError::CapacityExceeded)
        );
        assert_eq!(state.channel_poll(ORG, "text", "poll-0").unwrap(), original);
        assert_eq!(
            state.channel_poll(OTHER_ORG, "text", "poll-0"),
            Err(CoreError::OrganisationMismatch)
        );
        assert_eq!(
            state.channel_poll(ORG, "other", "poll-0"),
            Err(CoreError::PollNotFound)
        );
        state
            .switch_organisation(OTHER_ORG, [0x43; 32], HashSet::new(), 1)
            .unwrap();
        assert!(state.channel_polls.is_empty());
        assert_eq!(
            state.channel_poll(OTHER_ORG, "text", "poll-0"),
            Err(CoreError::PollNotFound)
        );
        state
            .create_channel_poll(
                OTHER_ORG,
                "text",
                "poll",
                "Question?",
                &["One".into(), "Two".into()],
                false,
            )
            .unwrap();
        assert!(state
            .switch_organisation("invalid", [0x43; 32], HashSet::new(), 1)
            .is_err());
        assert!(state.channel_polls.is_empty());
        assert_eq!(
            state.channel_poll(OTHER_ORG, "text", "poll"),
            Err(CoreError::TransportUnavailable)
        );
    }
    #[test]
    fn failed_poll_creation_and_votes_do_not_burn_or_replace_ids() {
        let mut state = session();
        assert_eq!(
            state.create_channel_poll(ORG, "text", "poll", "Question?", &["One".into()], false),
            Err(CoreError::InvalidPoll)
        );
        assert!(state.channel_polls.is_empty());
        state
            .create_channel_poll(
                ORG,
                "text",
                "poll",
                "Question?",
                &["One".into(), "Two".into()],
                false,
            )
            .unwrap();
        assert_eq!(
            state.vote_channel_poll(ORG, "text", "poll", ORG, &[99]),
            Err(CoreError::InvalidPollVote)
        );
        assert_eq!(
            state.channel_poll(ORG, "text", "poll").unwrap().total_votes,
            0
        );
        state
            .vote_channel_poll(ORG, "text", "poll", ORG, &[1])
            .unwrap();
        state.clear_session();
        assert!(state.channel_polls.is_empty());
    }
    #[test]
    fn iban_json_never_reflects_raw_account_in_request_response_or_errors() {
        let raw = "FR7612345678901234567890189";
        let request = json("redact_iban", &format!(r#", "raw_iban":"{raw}""#));
        let decoded = DesktopCommandRequest::from_json(&request).unwrap();
        assert!(!format!("{decoded:?}").contains(raw));
        assert!(!format!("{decoded}").contains(raw));
        let result = session().dispatch_command(&request);
        assert_eq!(
            result,
            DesktopCommandResponse::RedactedIban("FR76 **** **** **** **** ***0 189".into())
        );
        assert!(!format!("{result:?}").contains(raw));
        let error = session().dispatch_command(&request.replace("FR76", "fr76"));
        assert_eq!(
            error,
            DesktopCommandResponse::Error(DesktopCommandError::Core(CoreError::InvalidIban))
        );
        assert!(!format!("{error:?}").contains(raw));
        assert_eq!(
            session().dispatch_command(&request.replace(ORG, OTHER_ORG)),
            DesktopCommandResponse::Error(DesktopCommandError::Core(
                CoreError::OrganisationMismatch
            ))
        );
    }
    #[test]
    fn connector_url_json_is_org_fenced_and_metadata_only() {
        let request = json(
            "validate_connector_post_url",
            r#", "raw_url":"https://social.example.org:443/@member/42""#,
        );
        assert_eq!(
            session().dispatch_command(&request),
            DesktopCommandResponse::ConnectorPostUrl(
                "https://social.example.org/@member/42".into()
            )
        );
        assert_eq!(
            session().dispatch_command(&request.replace(ORG, OTHER_ORG)),
            DesktopCommandResponse::Error(DesktopCommandError::Core(
                CoreError::OrganisationMismatch
            ))
        );
        assert_eq!(
            session().dispatch_command(&request.replace("https://", "http://")),
            DesktopCommandResponse::Error(DesktopCommandError::Core(
                CoreError::InvalidConnectorUrl
            ))
        );
    }

    fn profile_json() -> String {
        json(
            "update_user_profile",
            &format!(
                r#", "user_id":"{ORG}","display_name":"Member","handle":"member","role_title":"Reviewer","presence":"online","rank":"member""#
            ),
        )
    }
    fn save_json(pad: &str, channel: &str, body: &str) -> String {
        json(
            "save_docs_pad",
            &format!(
                r#", "pad_id":"{pad}","channel_id":"{channel}","title":"Title","markdown_body":"{body}","actor":"local-author""#
            ),
        )
    }
    #[test]
    fn preferences_six_json_routes_keep_org_fences_and_new_op_form() {
        let mut state = session();
        assert!(matches!(
            state.dispatch_command(&json("set_theme_mode", r#", "mode":"black""#)),
            DesktopCommandResponse::ThemeMode {
                mode: CoreThemeMode::RealBlack,
                ..
            }
        ));
        let DesktopCommandResponse::ShareableThemeCode(code) =
            state.dispatch_command(&json("export_shareable_theme", ""))
        else {
            panic!("theme code");
        };
        let import = json("import_shareable_theme", &format!(r#", "code":"{code}""#));
        let DesktopCommandResponse::ShareableTheme(theme) = state.dispatch_command(&import) else {
            panic!("theme");
        };
        assert_eq!(theme.id, "preset-real-black-oled");
        assert!(matches!(
            state.dispatch_command(&profile_json()),
            DesktopCommandResponse::UserProfile(_)
        ));
        let iam = json(
            "evaluate_channel_iam",
            r#", "channel_id":"text","rank":"moderator""#,
        );
        let DesktopCommandResponse::ChannelAccess(d) = state.dispatch_command(&iam) else {
            panic!("decision");
        };
        assert!(d.can_manage && d.can_create_poll && !d.can_manage_connectors && !d.can_join_voice);
        let save = save_json("pad", "text", "body");
        assert!(matches!(
            state.dispatch_command(&save),
            DesktopCommandResponse::DocsPad(_)
        ));
        assert!(matches!(
            state.dispatch_command(
                &json("set_theme_mode", r#", "mode":"light""#).replace("\"command\"", "\"op\"")
            ),
            DesktopCommandResponse::ThemeMode {
                mode: CoreThemeMode::Light,
                ..
            }
        ));
        for request in [
            json("set_theme_mode", r#", "mode":"black""#),
            import,
            json("export_shareable_theme", ""),
            profile_json(),
            iam,
            save,
        ] {
            assert_eq!(
                state.dispatch_command(&request.replacen(ORG, OTHER_ORG, 1)),
                DesktopCommandResponse::Error(DesktopCommandError::Core(
                    CoreError::OrganisationMismatch
                ))
            );
        }
    }
    #[test]
    fn preferences_unknown_duplicate_fields_and_alias_conflicts_are_transactional() {
        let mut state = session();
        state.dispatch_command(&profile_json());
        state.dispatch_command(&save_json("pad", "text", "body"));
        let before_theme = state.export_shareable_theme(ORG).unwrap();
        let before_profile = state.user_profile(ORG).unwrap();
        let before_doc = state.docs_pad(ORG, "pad").unwrap();
        for raw in [
            json("set_theme_mode", r#", "mode":"light","mode":"black""#),
            json("set_theme_mode", r#", "mode":"light","\u006dode":"black""#),
            json("set_theme_mode", r#", "mode":"light","extra":false"#),
            json("set_theme_mode", r#", "mode":1"#),
            profile_json().replace("\"rank\"", "\"role\""),
            json(
                "evaluate_channel_iam",
                r#", "channel_id":"text","rank":"owner","min_read_rank":"guest""#,
            ),
            json(
                "get_sound_pack",
                r#", "op":"set_theme_mode","mode":"light""#,
            ),
            json("clear_workspace_session", "").replace("\"command\"", "\"op\""),
            json("import_shareable_theme", r#", "code":"invalid""#),
        ] {
            assert!(
                matches!(
                    state.dispatch_command(&raw),
                    DesktopCommandResponse::Error(_)
                ),
                "schema refusal"
            );
            assert_eq!(state.export_shareable_theme(ORG).unwrap(), before_theme);
            assert_eq!(state.user_profile(ORG).unwrap(), before_profile);
            assert_eq!(state.docs_pad(ORG, "pad").unwrap(), before_doc);
        }
    }
    #[test]
    fn theme_mode_switch_discards_custom_palette_without_changing_sound_preference() {
        let mut state = session();
        state.set_sound_pack(ORG, SoundPackId::Silent).unwrap();
        let theme = kodera_rs::curated_desktop_themes()[2].clone();
        let code = kodera_rs::encode_shareable_theme(&theme).unwrap();
        state.import_shareable_theme(ORG, &code).unwrap();
        assert_eq!(state.export_shareable_theme(ORG).unwrap(), code);
        assert!(state.import_shareable_theme(ORG, "bad").is_err());
        assert_eq!(state.export_shareable_theme(ORG).unwrap(), code);
        state.set_theme_mode(ORG, CoreThemeMode::Light).unwrap();
        let next =
            kodera_rs::decode_shareable_theme(&state.export_shareable_theme(ORG).unwrap()).unwrap();
        assert_eq!(next.base_mode, CoreThemeMode::Light);
        assert_eq!(state.sound_pack(ORG), Ok(SoundPackId::Silent));
    }
    #[test]
    fn typed_profile_revalidates_public_fields_before_session_retention() {
        let mut state = session();
        state.dispatch_command(&profile_json());
        let before = state.user_profile(ORG).unwrap().unwrap();
        let mut invalid = before.clone();
        invalid.display_name = "bad\n".into();
        assert!(state.update_user_profile(ORG, invalid).is_err());
        assert_eq!(state.user_profile(ORG).unwrap(), Some(before));
    }
    #[test]
    fn docs_typed_64kib_and_json_16kib_limits_are_separate_and_transactional() {
        let mut state = session();
        let body = "x".repeat(65_536);
        let d = state
            .save_docs_pad(ORG, "pad", "text", "Title", &body, "author")
            .unwrap();
        assert_eq!(d.markdown_body.len(), 65_536);
        let request = save_json("pad", "text", &body);
        assert!(request.len() > MAX_IPC_COMMAND_BYTES);
        assert_eq!(
            state.dispatch_command(&request),
            DesktopCommandResponse::Error(DesktopCommandError::RequestTooLarge)
        );
        let before = state.docs_pad(ORG, "pad").unwrap();
        assert!(state
            .save_docs_pad(ORG, "pad", "other", "Title", "body", "author")
            .is_err());
        assert!(state
            .save_docs_pad(ORG, "pad", "text", "Title", &"x".repeat(65_537), "author")
            .is_err());
        assert_eq!(state.docs_pad(ORG, "pad").unwrap(), before);
        assert_eq!(
            state
                .save_docs_pad(ORG, "pad", "text", "Next", "body", "author")
                .unwrap()
                .revision,
            2
        );
    }
    #[test]
    fn docs_registry_capacity_replacements_and_failed_identity_do_not_leak() {
        let mut state = session();
        for i in 0..kodera_rs::MAX_DOCS_PADS {
            state
                .save_docs_pad(ORG, &format!("pad-{i}"), "text", "Title", "body", "author")
                .unwrap();
        }
        assert_eq!(
            state.save_docs_pad(ORG, "overflow", "text", "Title", "body", "author"),
            Err(CoreError::CapacityExceeded)
        );
        assert_eq!(state.docs_pads.len(), kodera_rs::MAX_DOCS_PADS);
        assert_eq!(
            state
                .save_docs_pad(ORG, "pad-0", "text", "Next", "body", "author")
                .unwrap()
                .revision,
            2
        );
        assert!(state
            .save_docs_pad(ORG, " bad", "text", "Title", "body", "author")
            .is_err());
        assert_eq!(state.docs_pads.len(), kodera_rs::MAX_DOCS_PADS);
    }
    #[test]
    fn preference_teardown_and_failed_switch_erase_profile_theme_and_docs() {
        let mut state = session();
        state.dispatch_command(&profile_json());
        state.dispatch_command(&save_json("pad", "text", "body"));
        let code =
            kodera_rs::encode_shareable_theme(&kodera_rs::curated_desktop_themes()[2]).unwrap();
        state.import_shareable_theme(ORG, &code).unwrap();
        assert!(state
            .switch_organisation("invalid", [0; 32], Default::default(), 1)
            .is_err());
        assert!(
            state.custom_theme.is_none()
                && state.user_profile.is_none()
                && state.docs_pads.is_empty()
        );
        assert!(state.export_shareable_theme(ORG).is_err());
    }

    fn audit_workspace() -> DesktopWorkspaceSession {
        let mut state = session();
        populate(&mut state, 1, 1);
        state
            .configure_docs_host(ORG, Some("docs.example.org"))
            .unwrap();
        state
            .create_channel_poll(
                ORG,
                "text",
                "poll",
                "Choose?",
                &["One".into(), "Two".into()],
                true,
            )
            .unwrap();
        assert!(matches!(
            state.dispatch_command(&profile_json()),
            DesktopCommandResponse::UserProfile(_)
        ));
        state
            .save_docs_pad(ORG, "pad", "text", "Title", "body", "local-author")
            .unwrap();
        state
    }

    /// The complete current JSON surface, including routes added after the original shell.
    fn audit_command_cases() -> Vec<(&'static str, String)> {
        let theme =
            kodera_rs::encode_shareable_theme(&kodera_rs::curated_desktop_themes()[1]).unwrap();
        vec![
            (
                "plan_self_host",
                json(
                    "plan_self_host",
                    &format!(
                        r#","provider":"scaleway","region":"fr-par-1","fqdn":"chat.example.org","acme_email":"ops@example.org","raw_token":"{TOKEN}""#
                    ),
                ),
            ),
            (
                "validate_docs_pad_url",
                json(
                    "validate_docs_pad_url",
                    r#","raw_url":"https://docs.example.org/docs/one""#,
                ),
            ),
            (
                "proximity_current_beacon",
                json("proximity_current_beacon", r#","now_unix_secs":1"#),
            ),
            (
                "proximity_member_statuses",
                json("proximity_member_statuses", ""),
            ),
            (
                "proximity_next_relay_batch",
                json("proximity_next_relay_batch", r#","max_frames":128"#),
            ),
            (
                "clear_workspace_session",
                json("clear_workspace_session", ""),
            ),
            (
                "set_sound_pack",
                json("set_sound_pack", r#","sound_pack":"silent""#),
            ),
            ("get_sound_pack", json("get_sound_pack", "")),
            (
                "create_channel_poll",
                json(
                    "create_channel_poll",
                    r#","channel_id":"text","poll_id":"new-poll","question":"New?","options":["Yes","No"],"allow_multiple":false"#,
                ),
            ),
            (
                "vote_channel_poll",
                poll_request(
                    "vote_channel_poll",
                    &format!(r#","voter_id":"{ORG}","selections":[1]"#),
                ),
            ),
            ("get_channel_poll", poll_request("get_channel_poll", "")),
            ("close_channel_poll", poll_request("close_channel_poll", "")),
            (
                "redact_iban",
                json(
                    "redact_iban",
                    r#","raw_iban":"FR7612345678901234567890189""#,
                ),
            ),
            (
                "validate_connector_post_url",
                json(
                    "validate_connector_post_url",
                    r#","raw_url":"https://social.example.org:443/@member/42""#,
                ),
            ),
            (
                "set_theme_mode",
                json("set_theme_mode", r#","mode":"light""#),
            ),
            (
                "import_shareable_theme",
                json("import_shareable_theme", &format!(r#","code":"{theme}""#)),
            ),
            ("export_shareable_theme", json("export_shareable_theme", "")),
            ("update_user_profile", profile_json()),
            (
                "evaluate_channel_iam",
                json(
                    "evaluate_channel_iam",
                    r#","channel_id":"text","rank":"moderator""#,
                ),
            ),
            ("save_docs_pad", save_json("pad", "text", "updated")),
        ]
    }

    #[test]
    fn complete_twenty_route_json_flow_reaches_each_typed_result() {
        let cases = audit_command_cases();
        assert_eq!(cases.len(), 20);
        assert_eq!(
            cases
                .iter()
                .map(|(name, _)| *name)
                .collect::<std::collections::BTreeSet<_>>()
                .len(),
            20
        );
        for (name, request) in cases {
            let mut state = audit_workspace();
            let response = state.dispatch_command(&request);
            assert!(!format!("{response:?}").contains(TOKEN));
            match (name, response) {
                ("plan_self_host", DesktopCommandResponse::SelfHostPlan(plan)) => {
                    assert!(!plan.required_dns.is_empty());
                }
                ("validate_docs_pad_url", DesktopCommandResponse::DocsPadUrl(url)) => {
                    assert_eq!(url.as_str(), "https://docs.example.org/docs/one");
                }
                (
                    "proximity_current_beacon",
                    DesktopCommandResponse::ProximityBeacon { bytes, hex },
                ) => {
                    assert_eq!(bytes, state.current_beacon(ORG, 1).unwrap());
                    assert_eq!(hex, encode_hex(&bytes));
                }
                (
                    "proximity_member_statuses",
                    DesktopCommandResponse::ProximityMemberStatuses(members),
                ) => assert_eq!(members.len(), 1),
                (
                    "proximity_next_relay_batch",
                    DesktopCommandResponse::ProximityRelayBatch(frames),
                ) => {
                    assert_eq!(frames.len(), 1);
                    assert!(state.next_relay_batch(ORG, 1).unwrap().is_empty());
                }
                ("clear_workspace_session", DesktopCommandResponse::WorkspaceSessionCleared) => {
                    assert!(state.organisation_id().is_none());
                    assert!(state.user_profile.is_none() && state.docs_pads.is_empty());
                }
                ("set_sound_pack", DesktopCommandResponse::SoundPack(SoundPackId::Silent))
                | ("get_sound_pack", DesktopCommandResponse::SoundPack(SoundPackId::Givre)) => {}
                ("create_channel_poll", DesktopCommandResponse::ChannelPoll(poll)) => {
                    assert_eq!(poll.question, "New?");
                    assert_eq!(poll.options.len(), 2);
                    assert_eq!(poll.total_votes, 0);
                }
                ("vote_channel_poll", DesktopCommandResponse::ChannelPoll(poll)) => {
                    assert_eq!(poll.total_votes, 1);
                    assert_eq!(poll.options[1].vote_count, 1);
                }
                ("get_channel_poll", DesktopCommandResponse::ChannelPoll(poll)) => {
                    assert_eq!(poll.total_votes, 0);
                    assert!(!poll.is_closed);
                }
                ("close_channel_poll", DesktopCommandResponse::ChannelPoll(poll)) => {
                    assert!(poll.is_closed);
                }
                ("redact_iban", DesktopCommandResponse::RedactedIban(masked)) => {
                    assert_eq!(masked, "FR76 **** **** **** **** ***0 189");
                }
                ("validate_connector_post_url", DesktopCommandResponse::ConnectorPostUrl(url)) => {
                    assert_eq!(url, "https://social.example.org/@member/42");
                }
                (
                    "set_theme_mode",
                    DesktopCommandResponse::ThemeMode {
                        mode: CoreThemeMode::Light,
                        monogram_bg_hex: "#000000",
                    },
                ) => {}
                ("import_shareable_theme", DesktopCommandResponse::ShareableTheme(theme)) => {
                    assert_eq!(theme.id, "preset-cobalt-polaire");
                }
                ("export_shareable_theme", DesktopCommandResponse::ShareableThemeCode(code)) => {
                    assert_eq!(
                        kodera_rs::decode_shareable_theme(&code).unwrap().id,
                        "preset-real-black-oled"
                    );
                }
                ("update_user_profile", DesktopCommandResponse::UserProfile(profile)) => {
                    assert_eq!(profile.handle, "member");
                }
                ("evaluate_channel_iam", DesktopCommandResponse::ChannelAccess(decision)) => {
                    assert!(decision.can_read && decision.can_write && decision.can_manage);
                    assert!(decision.can_create_poll && !decision.can_manage_connectors);
                }
                ("save_docs_pad", DesktopCommandResponse::DocsPad(document)) => {
                    assert_eq!(document.markdown_body, "updated");
                    assert_eq!(document.revision, 2);
                    assert!(document
                        .export_markdown_with_frontmatter()
                        .ends_with("updated"));
                }
                (route, unexpected) => {
                    panic!("{route} produced unexpected response: {unexpected:?}")
                }
            }
        }
    }

    #[test]
    fn every_json_route_refuses_foreign_duplicate_unknown_and_wrong_typed_scope_without_effects() {
        let snapshot = |state: &DesktopWorkspaceSession| {
            (
                state.sound_pack(ORG).unwrap(),
                state.export_shareable_theme(ORG).unwrap(),
                state.user_profile(ORG).unwrap(),
                state.docs_pad(ORG, "pad").unwrap(),
                state.channel_poll(ORG, "text", "poll").unwrap(),
                state.member_statuses(ORG).unwrap(),
                state.allowed_docs_host.clone(),
            )
        };
        for (name, request) in audit_command_cases()
            .into_iter()
            .chain(legacy_route_cases())
        {
            let stem = request.strip_suffix('}').unwrap();
            let attempts = [
                (
                    request.replacen(ORG, OTHER_ORG, 1),
                    DesktopCommandError::Core(CoreError::OrganisationMismatch),
                ),
                (
                    format!(r#"{stem},"organisation_\u0069d":"{ORG}"}}"#),
                    DesktopCommandError::InvalidRequest,
                ),
                (
                    format!(r#"{stem},"audit_unknown":true}}"#),
                    DesktopCommandError::InvalidRequest,
                ),
                (
                    request.replacen(
                        &format!(r#""organisation_id":"{ORG}""#),
                        r#""organisation_id":true"#,
                        1,
                    ),
                    DesktopCommandError::InvalidRequest,
                ),
            ];
            for (input, error) in attempts {
                let mut state = audit_workspace();
                let before = snapshot(&state);
                assert_eq!(
                    state.dispatch_command(&input),
                    DesktopCommandResponse::Error(error),
                    "route {name} must refuse the adversarial envelope"
                );
                assert_eq!(snapshot(&state), before, "route {name} changed payload");
                assert_eq!(
                    state.next_relay_batch(ORG, 128).unwrap().len(),
                    1,
                    "route {name} drained the proximity queue"
                );
            }
        }
    }

    #[test]
    fn every_json_route_fails_closed_after_workspace_teardown() {
        for (name, request) in audit_command_cases()
            .into_iter()
            .chain(legacy_route_cases())
        {
            let mut state = audit_workspace();
            state.clear_session();
            assert_eq!(
                state.dispatch_command(&request),
                DesktopCommandResponse::Error(DesktopCommandError::Core(
                    CoreError::TransportUnavailable
                )),
                "ended workspace route {name} must remain unavailable"
            );
            assert!(state.organisation_id().is_none());
            assert!(state.user_profile.is_none() && state.docs_pads.is_empty());
        }
    }

    /// The three legacy names, spelled here on purpose: this list does not read the table it pins.
    const PINNED_LEGACY_ROUTES: [(&str, &str); 3] = [
        ("emergency_current_beacon", "proximity_current_beacon"),
        ("emergency_member_statuses", "proximity_member_statuses"),
        ("emergency_next_relay_batch", "proximity_next_relay_batch"),
    ];

    /// Each proximity request of the audit, re-addressed to its legacy route name.
    fn legacy_route_cases() -> Vec<(&'static str, String)> {
        let canonical = audit_command_cases();
        PINNED_LEGACY_ROUTES
            .iter()
            .map(|(legacy, proximity)| {
                let (_, request) = canonical
                    .iter()
                    .find(|(name, _)| name == proximity)
                    .expect("every proximity route is in the audit");
                let renamed = request.replacen(
                    &format!(r#""command":"{proximity}""#),
                    &format!(r#""command":"{legacy}""#),
                    1,
                );
                assert_ne!(&renamed, request);
                (*legacy, renamed)
            })
            .collect()
    }

    /// Everything a proximity route can change or reveal, for comparing two sessions.
    fn proximity_outcome(
        state: &mut DesktopWorkspaceSession,
        request: &str,
        aliases: &[(&'static str, &'static str)],
    ) -> (DesktopCommandResponse, usize, usize) {
        let response = state.dispatch_command_with_aliases(request, aliases);
        let members = state
            .member_statuses(ORG)
            .map_or(0, |members| members.len());
        let queued = state
            .next_relay_batch(ORG, 128)
            .map_or(0, |frames| frames.len());
        (response, members, queued)
    }

    /// The dual-name contract: with `aliases` in force, each legacy route answers exactly like its
    /// proximity route, on success and on every refusal, and leaves the same state behind.
    fn legacy_routes_answer_like_proximity_routes(
        aliases: &[(&'static str, &'static str)],
    ) -> Result<(), String> {
        let canonical = audit_command_cases();
        for ((legacy, legacy_request), (_, proximity)) in
            legacy_route_cases().into_iter().zip(PINNED_LEGACY_ROUTES)
        {
            let (_, proximity_request) = canonical
                .iter()
                .find(|(name, _)| *name == proximity)
                .expect("every proximity route is in the audit");
            let variants = |request: &str| {
                let stem = request.strip_suffix('}').unwrap();
                vec![
                    request.to_owned(),
                    request.replacen(ORG, OTHER_ORG, 1),
                    format!(r#"{stem},"audit_unknown":true}}"#),
                    format!(r#"{stem},"max_frames":"128"}}"#),
                ]
            };
            for (index, (old, new)) in variants(&legacy_request)
                .into_iter()
                .zip(variants(proximity_request))
                .enumerate()
            {
                let answered_old = proximity_outcome(&mut audit_workspace(), &old, aliases);
                let answered_new = proximity_outcome(&mut audit_workspace(), &new, aliases);
                if answered_old != answered_new {
                    return Err(format!(
                        "{legacy} differs from {proximity} on variant {index}"
                    ));
                }
                let succeeded = !matches!(answered_new.0, DesktopCommandResponse::Error(_));
                if succeeded != (index == 0) {
                    return Err(format!("{proximity} variant {index} had the wrong verdict"));
                }
            }
            for ended in [&legacy_request, proximity_request] {
                let mut state = audit_workspace();
                state.clear_session();
                if state.dispatch_command_with_aliases(ended, aliases)
                    != DesktopCommandResponse::Error(DesktopCommandError::Core(
                        CoreError::TransportUnavailable,
                    ))
                {
                    return Err(format!("{legacy} or {proximity} answered after teardown"));
                }
            }
        }
        Ok(())
    }

    #[test]
    fn legacy_emergency_routes_are_permanent_aliases_of_the_proximity_routes() {
        assert_eq!(LEGACY_ROUTE_ALIASES, PINNED_LEGACY_ROUTES);
        assert_eq!(
            legacy_routes_answer_like_proximity_routes(&LEGACY_ROUTE_ALIASES),
            Ok(())
        );
        // Through the public entry point too: each name reaches its typed proximity result.
        for (name, request) in legacy_route_cases() {
            let mut state = audit_workspace();
            match (name, state.dispatch_command(&request)) {
                (
                    "emergency_current_beacon",
                    DesktopCommandResponse::ProximityBeacon { bytes, hex },
                ) => {
                    assert_eq!(bytes, state.current_beacon(ORG, 1).unwrap());
                    assert_eq!(hex, encode_hex(&bytes));
                }
                (
                    "emergency_member_statuses",
                    DesktopCommandResponse::ProximityMemberStatuses(members),
                ) => {
                    assert_eq!(members.len(), 1);
                    assert_eq!(
                        members[0].sender_handle,
                        ProximityHandle::generated(&members[0].sender_public_key)
                    );
                }
                (
                    "emergency_next_relay_batch",
                    DesktopCommandResponse::ProximityRelayBatch(frames),
                ) => {
                    assert_eq!(frames.len(), 1);
                    assert!(state.next_relay_batch(ORG, 1).unwrap().is_empty());
                }
                (route, unexpected) => {
                    panic!("{route} produced unexpected response: {unexpected:?}")
                }
            }
        }
        // An alias is a route name only: it is not admitted through the `op` discriminator, and
        // no other spelling of the old name is invented.
        for request in [
            format!(r#"{{"op":"emergency_member_statuses","organisation_id":"{ORG}"}}"#),
            json("Emergency_member_statuses", ""),
            json("emergency_member_status", ""),
            json("urgence_member_statuses", ""),
        ] {
            assert_eq!(
                audit_workspace().dispatch_command(&request),
                DesktopCommandResponse::Error(DesktopCommandError::InvalidRequest)
            );
        }
    }

    /// Refusal mutation: drop one alias at a time. The legacy name must then be refused and the
    /// dual-name check above must fail, while the proximity name keeps answering.
    #[test]
    fn dropping_any_legacy_alias_is_refused_by_the_dual_name_check() {
        for (dropped, (legacy, proximity)) in PINNED_LEGACY_ROUTES.into_iter().enumerate() {
            let mutated: Vec<(&'static str, &'static str)> = LEGACY_ROUTE_ALIASES
                .into_iter()
                .enumerate()
                .filter(|(index, _)| *index != dropped)
                .map(|(_, pair)| pair)
                .collect();
            assert_eq!(mutated.len(), 2);
            let failure = legacy_routes_answer_like_proximity_routes(&mutated)
                .expect_err("a dropped alias must fail the dual-name check");
            assert!(failure.starts_with(legacy), "{failure}");

            let (_, legacy_request) = legacy_route_cases().swap_remove(dropped);
            assert_eq!(
                audit_workspace().dispatch_command_with_aliases(&legacy_request, &mutated),
                DesktopCommandResponse::Error(DesktopCommandError::InvalidRequest),
                "{legacy} without its alias"
            );
            let proximity_request =
                legacy_request.replacen(&format!(r#""{legacy}""#), &format!(r#""{proximity}""#), 1);
            assert!(!matches!(
                audit_workspace().dispatch_command_with_aliases(&proximity_request, &mutated),
                DesktopCommandResponse::Error(_)
            ));
        }
        // An alias pointing at another route is caught as well.
        let crossed = [
            ("emergency_current_beacon", "proximity_member_statuses"),
            LEGACY_ROUTE_ALIASES[1],
            LEGACY_ROUTE_ALIASES[2],
        ];
        assert!(legacy_routes_answer_like_proximity_routes(&crossed).is_err());
    }
}
