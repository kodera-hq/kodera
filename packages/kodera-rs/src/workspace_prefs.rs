//! Bounded local preferences and document models. Role metadata is not authentication.
use crate::{CoreError, OrganisationId};
use std::collections::BTreeMap;

pub type ThemeCodecError = CoreError;
pub type ProfileIamError = CoreError;
pub type DocsPadError = CoreError;
pub const KODERA_MONOGRAM_BG_RGB: [u8; 3] = [0, 0, 0];
pub const KODERA_MONOGRAM_BG_HEX: &str = "#000000";
pub const THEME_SHARE_PREFIX: &str = "kodera-theme:v1:";
pub const MAX_THEME_SHARE_CODE_BYTES: usize = 2048;
pub const MAX_DOCS_PAD_MARKDOWN_BYTES: usize = 65_536;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum CoreThemeMode {
    Light,
    Dark,
    RealBlack,
}
impl CoreThemeMode {
    pub fn parse(value: &str) -> Result<Self, CoreError> {
        match value {
            "light" => Ok(Self::Light),
            "dark" => Ok(Self::Dark),
            "black" => Ok(Self::RealBlack),
            _ => Err(CoreError::InvalidTheme),
        }
    }
    pub const fn as_slug(self) -> &'static str {
        match self {
            Self::Light => "light",
            Self::Dark => "dark",
            Self::RealBlack => "black",
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CustomThemePalette {
    pub page_rgb: [u8; 3],
    pub surface_rgb: [u8; 3],
    pub sunken_rgb: [u8; 3],
    pub action_rgb: [u8; 3],
    pub ink_rgb: [u8; 3],
}
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ShareableThemePayload {
    pub id: String,
    pub name: String,
    pub author: String,
    pub base_mode: CoreThemeMode,
    pub palette: CustomThemePalette,
}

// Same pinned Unicode15.1 format-control policy as native poll metadata; no normalization.
fn forbidden(c: char) -> bool {
    c.is_control()
        || matches!(c as u32, 0x00ad | 0x0600..=0x0605 | 0x061c | 0x06dd | 0x070f |
        0x0890..=0x0891 | 0x08e2 | 0x180e | 0x200b..=0x200f | 0x2028..=0x202e |
        0x2060..=0x2064 | 0x2066..=0x206f | 0xfeff | 0xfff9..=0xfffb | 0x110bd |
        0x110cd | 0x13430..=0x1343f | 0x1bca0..=0x1bca3 | 0x1d173..=0x1d17a |
        0xe0001 | 0xe0020..=0xe007f)
}
fn text(value: &str, bytes: usize) -> bool {
    !value.is_empty()
        && value.len() <= bytes
        && value == value.trim()
        && !value.chars().any(forbidden)
}
fn slug(value: &str, maximum: usize) -> bool {
    !value.is_empty()
        && value.len() <= maximum
        && value
            .bytes()
            .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'-')
}
fn identifier(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 255
        && value
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || matches!(b, b'-' | b'_' | b'.' | b':'))
}
fn validate_theme(payload: &ShareableThemePayload) -> Result<(), CoreError> {
    if !slug(&payload.id, 64) || !text(&payload.name, 64) || !text(&payload.author, 64) {
        return Err(CoreError::InvalidTheme);
    }
    Ok(())
}
fn rgb(value: [u8; 3]) -> String {
    format!("rgb({}, {}, {})", value[0], value[1], value[2])
}
fn quoted(value: &str) -> String {
    let mut result = String::with_capacity(value.len() + 2);
    result.push('"');
    for c in value.chars() {
        match c {
            '"' => result.push_str("\\\""),
            '\\' => result.push_str("\\\\"),
            '\n' => result.push_str("\\n"),
            '\r' => result.push_str("\\r"),
            '\t' => result.push_str("\\t"),
            c if c.is_control() => result.push_str(&format!("\\u{:04x}", c as u32)),
            _ => result.push(c),
        }
    }
    result.push('"');
    result
}
pub fn encode_shareable_theme(payload: &ShareableThemePayload) -> Result<String, ThemeCodecError> {
    validate_theme(payload)?;
    let p = &payload.palette;
    let json = format!("{{\"v\":1,\"id\":{},\"name\":{},\"author\":{},\"baseMode\":{},\"tokens\":{{\"--c-page\":{},\"--c-surface\":{},\"--c-sunken\":{},\"--c-action\":{},\"--c-ink\":{}}}}}",
        quoted(&payload.id), quoted(&payload.name), quoted(&payload.author), quoted(payload.base_mode.as_slug()),
        quoted(&rgb(p.page_rgb)), quoted(&rgb(p.surface_rgb)), quoted(&rgb(p.sunken_rgb)), quoted(&rgb(p.action_rgb)), quoted(&rgb(p.ink_rgb)));
    let code = format!("{THEME_SHARE_PREFIX}{}", base64_encode(json.as_bytes()));
    if code.len() > MAX_THEME_SHARE_CODE_BYTES {
        return Err(CoreError::InvalidTheme);
    }
    Ok(code)
}
pub fn decode_shareable_theme(code: &str) -> Result<ShareableThemePayload, ThemeCodecError> {
    if code.len() > MAX_THEME_SHARE_CODE_BYTES {
        return Err(CoreError::InvalidTheme);
    }
    let encoded = code
        .strip_prefix(THEME_SHARE_PREFIX)
        .ok_or(CoreError::InvalidTheme)?;
    let bytes = base64_decode(encoded).ok_or(CoreError::InvalidTheme)?;
    let json = std::str::from_utf8(&bytes).map_err(|_| CoreError::InvalidTheme)?;
    let mut parser = ThemeParser {
        raw: json,
        offset: 0,
    };
    let mut root = parser.object(true)?;
    parser.whitespace();
    if parser.offset != json.len() || root.len() != 6 {
        return Err(CoreError::InvalidTheme);
    }
    if !matches!(root.remove("v"), Some(JsonValue::Version)) {
        return Err(CoreError::InvalidTheme);
    }
    let id = take_text(&mut root, "id")?;
    let name = take_text(&mut root, "name")?;
    let author = take_text(&mut root, "author")?;
    let base_mode = CoreThemeMode::parse(&take_text(&mut root, "baseMode")?)?;
    let Some(JsonValue::Tokens(mut tokens)) = root.remove("tokens") else {
        return Err(CoreError::InvalidTheme);
    };
    if tokens.len() != 5 || !root.is_empty() {
        return Err(CoreError::InvalidTheme);
    }
    let palette = CustomThemePalette {
        page_rgb: parse_rgb(&take_text(&mut tokens, "--c-page")?)?,
        surface_rgb: parse_rgb(&take_text(&mut tokens, "--c-surface")?)?,
        sunken_rgb: parse_rgb(&take_text(&mut tokens, "--c-sunken")?)?,
        action_rgb: parse_rgb(&take_text(&mut tokens, "--c-action")?)?,
        ink_rgb: parse_rgb(&take_text(&mut tokens, "--c-ink")?)?,
    };
    if !tokens.is_empty() {
        return Err(CoreError::InvalidTheme);
    }
    let payload = ShareableThemePayload {
        id,
        name,
        author,
        base_mode,
        palette,
    };
    validate_theme(&payload)?;
    Ok(payload)
}
fn parse_rgb(value: &str) -> Result<[u8; 3], CoreError> {
    let body = value
        .strip_prefix("rgb(")
        .and_then(|s| s.strip_suffix(')'))
        .ok_or(CoreError::InvalidTheme)?;
    let parts: Vec<_> = body.split(", ").collect();
    if parts.len() != 3 {
        return Err(CoreError::InvalidTheme);
    }
    let mut channels = [0; 3];
    for (out, part) in channels.iter_mut().zip(parts) {
        if part.is_empty() || part.len() > 3 || !part.bytes().all(|b| b.is_ascii_digit()) {
            return Err(CoreError::InvalidTheme);
        }
        *out = part.parse::<u8>().map_err(|_| CoreError::InvalidTheme)?;
    }
    if rgb(channels) != value {
        return Err(CoreError::InvalidTheme);
    }
    Ok(channels)
}
pub fn curated_desktop_themes() -> Vec<ShareableThemePayload> {
    let data = [
        (
            "preset-real-black-oled",
            "Real Black OLED",
            CoreThemeMode::RealBlack,
            [
                [0, 0, 0],
                [11, 12, 14],
                [6, 6, 7],
                [67, 97, 238],
                [241, 244, 248],
            ],
        ),
        (
            "preset-cobalt-polaire",
            "Polar Cobalt",
            CoreThemeMode::Light,
            [
                [255, 255, 255],
                [255, 255, 255],
                [238, 242, 246],
                [43, 75, 219],
                [30, 41, 51],
            ],
        ),
        (
            "preset-terminal-ambre",
            "Amber Terminal",
            CoreThemeMode::RealBlack,
            [
                [0, 0, 0],
                [16, 14, 10],
                [10, 8, 5],
                [216, 155, 60],
                [245, 230, 200],
            ],
        ),
        (
            "preset-foret-souveraine",
            "Sovereign Forest",
            CoreThemeMode::Dark,
            [
                [8, 16, 12],
                [14, 26, 20],
                [10, 19, 14],
                [53, 169, 106],
                [235, 245, 239],
            ],
        ),
    ];
    data.into_iter()
        .map(|(id, name, base_mode, c)| ShareableThemePayload {
            id: id.into(),
            name: name.into(),
            author: "Kodera Design System".into(),
            base_mode,
            palette: CustomThemePalette {
                page_rgb: c[0],
                surface_rgb: c[1],
                sunken_rgb: c[2],
                action_rgb: c[3],
                ink_rgb: c[4],
            },
        })
        .collect()
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum PresenceStatus {
    Online,
    Idle,
    DoNotDisturb,
    Offline,
}
impl PresenceStatus {
    pub fn parse(value: &str) -> Result<Self, CoreError> {
        match value {
            "online" => Ok(Self::Online),
            "idle" => Ok(Self::Idle),
            "dnd" => Ok(Self::DoNotDisturb),
            "offline" => Ok(Self::Offline),
            _ => Err(CoreError::InvalidUserProfile),
        }
    }
}
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord)]
#[repr(u8)]
pub enum OrgRoleRank {
    Guest = 0,
    Member = 10,
    Moderator = 50,
    Admin = 80,
    Owner = 100,
}
impl OrgRoleRank {
    pub const fn power_level(self) -> u8 {
        self as u8
    }
    pub fn parse(value: &str) -> Result<Self, CoreError> {
        match value {
            "guest" => Ok(Self::Guest),
            "member" => Ok(Self::Member),
            "moderator" => Ok(Self::Moderator),
            "admin" => Ok(Self::Admin),
            "owner" => Ok(Self::Owner),
            _ => Err(CoreError::InvalidIamPolicy),
        }
    }
}
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct UserProfile {
    pub user_id: String,
    pub display_name: String,
    pub handle: String,
    pub role_title: String,
    pub status_emoji: Option<String>,
    pub status_text: Option<String>,
    pub presence: PresenceStatus,
    pub rank: OrgRoleRank,
}
pub fn validate_user_profile(profile: &UserProfile) -> Result<(), ProfileIamError> {
    if OrganisationId::parse(&profile.user_id).is_err()
        || !text(&profile.display_name, 64)
        || !text(&profile.role_title, 64)
        || profile.handle.is_empty()
        || profile.handle.len() > 32
        || !profile.handle.bytes().all(|b| {
            b.is_ascii_lowercase() || b.is_ascii_digit() || matches!(b, b'.' | b'_' | b'-')
        })
        || profile
            .status_emoji
            .as_deref()
            .is_some_and(|v| !text(v, 16))
        || profile
            .status_text
            .as_deref()
            .is_some_and(|v| !text(v, 128))
    {
        return Err(CoreError::InvalidUserProfile);
    }
    Ok(())
}
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ChannelPermissionPolicy {
    pub channel_id: String,
    pub category_id: String,
    pub is_voice: bool,
    pub min_read_rank: OrgRoleRank,
    pub min_write_rank: OrgRoleRank,
    pub min_manage_rank: OrgRoleRank,
    pub allow_polls: bool,
    pub allow_connectors: bool,
}
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct ChannelAccessDecision {
    pub can_read: bool,
    pub can_write: bool,
    pub can_manage: bool,
    pub can_create_poll: bool,
    pub can_manage_connectors: bool,
    pub can_join_voice: bool,
}
/// Pure preview calculation, never a service authorization result. Invalid policy IDs deny all.
pub fn evaluate_channel_access(
    rank: OrgRoleRank,
    policy: &ChannelPermissionPolicy,
) -> ChannelAccessDecision {
    let can_read = identifier(&policy.channel_id)
        && identifier(&policy.category_id)
        && rank >= policy.min_read_rank;
    let can_write = can_read && rank >= policy.min_write_rank;
    let can_manage = can_read && rank >= policy.min_manage_rank;
    ChannelAccessDecision {
        can_read,
        can_write,
        can_manage,
        can_create_poll: can_write && policy.allow_polls,
        can_manage_connectors: can_manage && policy.allow_connectors,
        can_join_voice: can_read && policy.is_voice,
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DocsPadDocument {
    pub pad_id: String,
    pub channel_id: String,
    pub title: String,
    pub markdown_body: String,
    pub revision: u64,
    pub updated_by: String,
}
impl DocsPadDocument {
    pub fn new(
        pad_id: &str,
        channel_id: &str,
        title: &str,
        body: &str,
        actor: &str,
    ) -> Result<Self, DocsPadError> {
        if !identifier(pad_id)
            || !identifier(channel_id)
            || !text(title, 120)
            || body.len() > MAX_DOCS_PAD_MARKDOWN_BYTES
            || body
                .chars()
                .any(|c| forbidden(c) && !matches!(c, '\n' | '\r' | '\t'))
            || !identifier(actor)
        {
            return Err(CoreError::InvalidDocsPad);
        }
        Ok(Self {
            pad_id: pad_id.into(),
            channel_id: channel_id.into(),
            title: title.into(),
            markdown_body: body.into(),
            revision: 1,
            updated_by: actor.into(),
        })
    }
    pub fn validate_and_advance(
        &mut self,
        title: &str,
        body: &str,
        actor: &str,
    ) -> Result<u64, DocsPadError> {
        // Validate retained identity as well: public model fields are not a proof of admission.
        Self::new(
            &self.pad_id,
            &self.channel_id,
            &self.title,
            &self.markdown_body,
            &self.updated_by,
        )?;
        if self.revision == 0 {
            return Err(CoreError::InvalidDocsPad);
        }
        let revision = self
            .revision
            .checked_add(1)
            .ok_or(CoreError::InvalidDocsPad)?;
        let mut next = Self::new(&self.pad_id, &self.channel_id, title, body, actor)?;
        next.revision = revision;
        *self = next;
        Ok(revision)
    }
    /// Quoted metadata prevents YAML/frontmatter injection. Body stays literal Markdown, never HTML.
    pub fn export_markdown_with_frontmatter(&self) -> String {
        if self.revision == 0
            || Self::new(
                &self.pad_id,
                &self.channel_id,
                &self.title,
                &self.markdown_body,
                &self.updated_by,
            )
            .is_err()
        {
            return String::new();
        }
        format!(
            "---\npad_id: {}\nchannel_id: {}\ntitle: {}\nrevision: {}\nupdated_by: {}\n---\n\n{}",
            quoted(&self.pad_id),
            quoted(&self.channel_id),
            quoted(&self.title),
            self.revision,
            quoted(&self.updated_by),
            self.markdown_body
        )
    }
}

fn base64_encode(bytes: &[u8]) -> String {
    const TABLE: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let mut out = String::with_capacity(bytes.len().div_ceil(3) * 4);
    for c in bytes.chunks(3) {
        let a = c[0];
        let b = c.get(1).copied().unwrap_or(0);
        let d = c.get(2).copied().unwrap_or(0);
        out.push(TABLE[(a >> 2) as usize] as char);
        out.push(TABLE[(((a & 3) << 4) | (b >> 4)) as usize] as char);
        out.push(if c.len() > 1 {
            TABLE[(((b & 15) << 2) | (d >> 6)) as usize] as char
        } else {
            '='
        });
        out.push(if c.len() > 2 {
            TABLE[(d & 63) as usize] as char
        } else {
            '='
        });
    }
    out
}
fn base64_decode(value: &str) -> Option<Vec<u8>> {
    fn n(b: u8) -> Option<u8> {
        match b {
            b'A'..=b'Z' => Some(b - b'A'),
            b'a'..=b'z' => Some(b - b'a' + 26),
            b'0'..=b'9' => Some(b - b'0' + 52),
            b'+' => Some(62),
            b'/' => Some(63),
            _ => None,
        }
    }
    if value.is_empty() || value.len() % 4 != 0 {
        return None;
    }
    let mut out = Vec::with_capacity(value.len() / 4 * 3);
    for (i, c) in value.as_bytes().chunks_exact(4).enumerate() {
        let a = n(c[0])?;
        let b = n(c[1])?;
        let last = (i + 1) * 4 == value.len();
        let d = if c[2] == b'=' { 0 } else { n(c[2])? };
        let e = if c[3] == b'=' { 0 } else { n(c[3])? };
        if (c[2] == b'=' && (c[3] != b'=' || !last || b & 15 != 0))
            || (c[3] == b'=' && (!last || d & 3 != 0))
        {
            return None;
        }
        out.push((a << 2) | (b >> 4));
        if c[2] != b'=' {
            out.push((b << 4) | (d >> 2));
        }
        if c[3] != b'=' {
            out.push((d << 6) | e);
        }
    }
    Some(out)
}
enum JsonValue {
    Text(String),
    Version,
    Tokens(BTreeMap<String, JsonValue>),
}
fn take_text(map: &mut BTreeMap<String, JsonValue>, key: &str) -> Result<String, CoreError> {
    match map.remove(key) {
        Some(JsonValue::Text(s)) => Ok(s),
        _ => Err(CoreError::InvalidTheme),
    }
}
struct ThemeParser<'a> {
    raw: &'a str,
    offset: usize,
}
impl ThemeParser<'_> {
    fn peek(&self) -> Option<u8> {
        self.raw.as_bytes().get(self.offset).copied()
    }
    fn whitespace(&mut self) {
        while matches!(self.peek(), Some(b' ' | b'\n' | b'\r' | b'\t')) {
            self.offset += 1;
        }
    }
    fn expect(&mut self, b: u8) -> Result<(), CoreError> {
        if self.peek() != Some(b) {
            return Err(CoreError::InvalidTheme);
        }
        self.offset += 1;
        Ok(())
    }
    fn object(&mut self, root: bool) -> Result<BTreeMap<String, JsonValue>, CoreError> {
        self.whitespace();
        self.expect(b'{')?;
        self.whitespace();
        let mut fields = BTreeMap::new();
        if self.peek() != Some(b'}') {
            loop {
                if fields.len() == if root { 6 } else { 5 } {
                    return Err(CoreError::InvalidTheme);
                }
                let key = self.string()?;
                if fields.contains_key(&key) {
                    return Err(CoreError::InvalidTheme);
                }
                self.whitespace();
                self.expect(b':')?;
                self.whitespace();
                let value = match self.peek() {
                    Some(b'"') => JsonValue::Text(self.string()?),
                    Some(b'1') if root && key == "v" => {
                        self.offset += 1;
                        JsonValue::Version
                    }
                    Some(b'{') if root && key == "tokens" => JsonValue::Tokens(self.object(false)?),
                    _ => return Err(CoreError::InvalidTheme),
                };
                fields.insert(key, value);
                self.whitespace();
                match self.peek() {
                    Some(b',') => {
                        self.offset += 1;
                        self.whitespace();
                    }
                    Some(b'}') => break,
                    _ => return Err(CoreError::InvalidTheme),
                }
            }
        }
        self.expect(b'}')?;
        Ok(fields)
    }
    fn hex(&mut self) -> Result<u32, CoreError> {
        let mut n = 0;
        for _ in 0..4 {
            let b = self.peek().ok_or(CoreError::InvalidTheme)?;
            let d = (b as char).to_digit(16).ok_or(CoreError::InvalidTheme)?;
            self.offset += 1;
            n = (n << 4) | d;
        }
        Ok(n)
    }
    fn string(&mut self) -> Result<String, CoreError> {
        self.expect(b'"')?;
        let mut out = String::new();
        loop {
            let c = self.raw[self.offset..]
                .chars()
                .next()
                .ok_or(CoreError::InvalidTheme)?;
            self.offset += c.len_utf8();
            match c {
                '"' => return Ok(out),
                '\\' => {
                    let b = self.peek().ok_or(CoreError::InvalidTheme)?;
                    self.offset += 1;
                    let decoded = match b {
                        b'"' => '"',
                        b'\\' => '\\',
                        b'/' => '/',
                        b'b' => '\u{8}',
                        b'f' => '\u{c}',
                        b'n' => '\n',
                        b'r' => '\r',
                        b't' => '\t',
                        b'u' => {
                            let mut n = self.hex()?;
                            if (0xd800..=0xdbff).contains(&n) {
                                self.expect(b'\\')?;
                                self.expect(b'u')?;
                                let lo = self.hex()?;
                                if !(0xdc00..=0xdfff).contains(&lo) {
                                    return Err(CoreError::InvalidTheme);
                                }
                                n = 0x10000 + ((n - 0xd800) << 10) + (lo - 0xdc00);
                            }
                            char::from_u32(n).ok_or(CoreError::InvalidTheme)?
                        }
                        _ => return Err(CoreError::InvalidTheme),
                    };
                    out.push(decoded);
                }
                c if c < '\u{20}' => return Err(CoreError::InvalidTheme),
                _ => out.push(c),
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    const USER: &str = "11111111-1111-4111-8111-111111111111";
    fn profile() -> UserProfile {
        UserProfile {
            user_id: USER.into(),
            display_name: "Member".into(),
            handle: "member".into(),
            role_title: "Reviewer".into(),
            status_emoji: None,
            status_text: None,
            presence: PresenceStatus::Online,
            rank: OrgRoleRank::Member,
        }
    }
    fn code(raw: &str) -> String {
        format!("{THEME_SHARE_PREFIX}{}", base64_encode(raw.as_bytes()))
    }
    fn json() -> String {
        let encoded = encode_shareable_theme(&curated_desktop_themes()[0]).unwrap();
        String::from_utf8(base64_decode(encoded.strip_prefix(THEME_SHARE_PREFIX).unwrap()).unwrap())
            .unwrap()
    }
    #[test]
    fn theme_modes_and_pure_black_are_exact() {
        for (s, m) in [
            ("light", CoreThemeMode::Light),
            ("dark", CoreThemeMode::Dark),
            ("black", CoreThemeMode::RealBlack),
        ] {
            assert_eq!(CoreThemeMode::parse(s), Ok(m));
            assert_eq!(m.as_slug(), s);
        }
        for s in ["Black", " black", "oled", ""] {
            assert!(CoreThemeMode::parse(s).is_err());
        }
        assert_eq!(KODERA_MONOGRAM_BG_RGB, [0, 0, 0]);
        assert_eq!(KODERA_MONOGRAM_BG_HEX, "#000000");
    }
    #[test]
    fn curated_presets_and_shared_canonical_fixture_round_trip() {
        let themes = curated_desktop_themes();
        assert_eq!(themes.len(), 4);
        assert_eq!(
            themes.iter().map(|t| t.id.as_str()).collect::<Vec<_>>(),
            [
                "preset-real-black-oled",
                "preset-cobalt-polaire",
                "preset-terminal-ambre",
                "preset-foret-souveraine"
            ]
        );
        for theme in themes {
            let encoded = encode_shareable_theme(&theme).unwrap();
            assert!(encoded.len() <= 2048);
            assert_eq!(decode_shareable_theme(&encoded), Ok(theme));
        }
        assert_eq!(
            json(),
            r#"{"v":1,"id":"preset-real-black-oled","name":"Real Black OLED","author":"Kodera Design System","baseMode":"black","tokens":{"--c-page":"rgb(0, 0, 0)","--c-surface":"rgb(11, 12, 14)","--c-sunken":"rgb(6, 6, 7)","--c-action":"rgb(67, 97, 238)","--c-ink":"rgb(241, 244, 248)"}}"#
        );
    }
    const THEME_SHARE_VECTORS_JSON: &str = include_str!("../vectors/theme-share-v1.json");
    fn extract_json_string<'a>(line: &'a str, key: &str) -> Option<&'a str> {
        let needle = format!("\"{key}\":\"");
        let rest = &line[line.find(&needle)? + needle.len()..];
        Some(&rest[..rest.find('"')?])
    }
    #[test]
    fn shared_theme_share_v1_vectors_match_curated_presets_and_refusals() {
        let presets = curated_desktop_themes();
        let mut valid_count = 0usize;
        let mut invalid_count = 0usize;
        for raw_line in THEME_SHARE_VECTORS_JSON.lines() {
            let line = raw_line.trim();
            if line.starts_with("{\"id\":") {
                let id = extract_json_string(line, "id").unwrap();
                let code = extract_json_string(line, "code").unwrap();
                let expected = presets.iter().find(|t| t.id == id).expect(id);
                assert_eq!(encode_shareable_theme(expected).unwrap(), code, "{id}");
                assert_eq!(decode_shareable_theme(code).as_ref(), Ok(expected), "{id}");
                valid_count += 1;
            } else if line.starts_with("{\"name\":") {
                let name = extract_json_string(line, "name").unwrap();
                let code = extract_json_string(line, "code").unwrap();
                assert!(decode_shareable_theme(code).is_err(), "{name}");
                invalid_count += 1;
            }
        }
        assert_eq!(valid_count, 4);
        assert_eq!(invalid_count, 24);
    }
    #[test]
    fn theme_metadata_bounds_use_utf8_and_no_sanitizing() {
        for bad in [
            "",
            " name",
            "name ",
            "a\n",
            "a\u{200b}",
            "a\u{2028}",
            "a\u{2029}",
            &"é".repeat(33),
        ] {
            let mut t = curated_desktop_themes()[0].clone();
            t.name = bad.into();
            assert!(encode_shareable_theme(&t).is_err());
            t.name = "Valid".into();
            t.author = bad.into();
            assert!(encode_shareable_theme(&t).is_err());
        }
        let mut t = curated_desktop_themes()[0].clone();
        t.name = "é".repeat(32);
        t.author = "A \\".into();
        t.id = "a".repeat(64);
        assert_eq!(
            decode_shareable_theme(&encode_shareable_theme(&t).unwrap()),
            Ok(t.clone())
        );
        for id in ["", "UPPER", "a_b", "a.b", &"a".repeat(65)] {
            t.id = id.into();
            assert!(encode_shareable_theme(&t).is_err());
        }
    }
    #[test]
    fn theme_json_rejects_unknown_duplicate_nested_and_wrong_types() {
        let valid = json();
        for raw in [
            valid.replace("\"v\":1", "\"v\":1,\"v\":1"),
            valid.replace("\"v\":1", "\"v\":1,\"\\u0076\":1"),
            valid.replace("\"v\":1", "\"v\":1,\"other\":\"x\""),
            valid.replace("\"v\":1", "\"v\":1.0"),
            valid.replace("\"v\":1", "\"v\":true"),
            valid.replace("\"v\":1", "\"v\":2"),
            valid.replace("\"id\":", "\"identity\":"),
            valid.replace("\"tokens\":{", "\"tokens\":{\"nested\":{},"),
            valid.replace("\"--c-page\":", "\"other\":"),
            valid.replace(
                "\"--c-page\":",
                "\"--c-page\":\"rgb(0, 0, 0)\",\"--c-page\":",
            ),
            format!("{valid} garbage"),
            valid.replace("\"author\":\"Kodera Design System\",", ""),
            valid.replace("\"name\":\"Real Black OLED\"", "\"name\":\"\\ud800\""),
        ] {
            assert!(decode_shareable_theme(&code(&raw)).is_err(), "{raw}");
        }
    }
    #[test]
    fn theme_rgb_refuses_css_and_noncanonical_channels() {
        for value in [
            "rgb(256, 0, 0)",
            "rgb(-1, 0, 0)",
            "rgb(00, 0, 0)",
            "rgb(0,0,0)",
            "rgba(0, 0, 0, 1)",
            "#000000",
            "var(--c-page)",
            "rgb(0, 0, 0);url(x)",
        ] {
            let raw = json().replace("rgb(0, 0, 0)", value);
            assert!(decode_shareable_theme(&code(&raw)).is_err());
        }
    }
    #[test]
    fn theme_base64_requires_standard_canonical_padding_and_bound_before_trim() {
        for (raw, expected) in [
            ("Zg==", b"f".as_slice()),
            ("Zm8=", b"fo".as_slice()),
            ("Zm9v", b"foo".as_slice()),
        ] {
            assert_eq!(base64_decode(raw).as_deref(), Some(expected));
            assert_eq!(base64_encode(expected), raw);
        }
        for raw in [
            "", "Zg", "Zh==", "Zm9=", "Zg==Zg==", "Zg=", "Zg===", "Zg==\n", "Zg--", "Zg__", "=g==",
        ] {
            assert!(base64_decode(raw).is_none(), "{raw}");
        }
        let valid = encode_shareable_theme(&curated_desktop_themes()[0]).unwrap();
        assert!(decode_shareable_theme(&format!(" {valid}")).is_err());
        assert!(decode_shareable_theme(&format!("{valid} ")).is_err());
        assert!(
            decode_shareable_theme(&format!("{THEME_SHARE_PREFIX}{}", "A".repeat(2048))).is_err()
        );
    }
    #[test]
    fn valid_unicode_surrogate_pair_decodes_and_controls_do_not() {
        let raw = json().replace("Real Black OLED", r"\ud83e\udded");
        assert_eq!(decode_shareable_theme(&code(&raw)).unwrap().name, "🧭");
        for replacement in [r"\n", r"\u0000", r"\u202e", r"\udc00", r"\ud800x"] {
            let raw = json().replace("Real Black OLED", replacement);
            assert!(decode_shareable_theme(&code(&raw)).is_err());
        }
    }
    #[test]
    fn profile_rejects_invalid_ids_handle_metadata_and_optional_fields() {
        assert!(validate_user_profile(&profile()).is_ok());
        for value in [
            "",
            "00000000-0000-0000-0000-000000000000",
            "USER",
            "11111111-1111-4111-8111-11111111111A",
        ] {
            let mut p = profile();
            p.user_id = value.into();
            assert!(validate_user_profile(&p).is_err());
        }
        for value in ["", "@member", "UPPER", "a b", &"a".repeat(33)] {
            let mut p = profile();
            p.handle = value.into();
            assert!(validate_user_profile(&p).is_err());
        }
        for value in [
            "",
            " x",
            "x\n",
            "a\u{200b}",
            "a\u{2028}",
            "a\u{2029}",
            &"é".repeat(33),
        ] {
            let mut p = profile();
            p.display_name = value.into();
            assert!(validate_user_profile(&p).is_err());
            p = profile();
            p.role_title = value.into();
            assert!(validate_user_profile(&p).is_err());
        }
        let mut p = profile();
        p.display_name = "é".repeat(32);
        p.role_title = "a".repeat(64);
        p.status_text = Some("x".repeat(128));
        assert!(validate_user_profile(&p).is_ok());
        p.status_text = Some("x".repeat(129));
        assert!(validate_user_profile(&p).is_err());
        p.status_text = None;
        p.status_emoji = Some(String::new());
        assert!(validate_user_profile(&p).is_err());
    }
    fn policy() -> ChannelPermissionPolicy {
        ChannelPermissionPolicy {
            channel_id: "text".into(),
            category_id: "general".into(),
            is_voice: false,
            min_read_rank: OrgRoleRank::Member,
            min_write_rank: OrgRoleRank::Moderator,
            min_manage_rank: OrgRoleRank::Admin,
            allow_polls: true,
            allow_connectors: true,
        }
    }
    #[test]
    fn iam_rank_table_and_prerequisites_are_deterministic() {
        let ranks = [
            OrgRoleRank::Guest,
            OrgRoleRank::Member,
            OrgRoleRank::Moderator,
            OrgRoleRank::Admin,
            OrgRoleRank::Owner,
        ];
        assert_eq!(ranks.map(OrgRoleRank::power_level), [0, 10, 50, 80, 100]);
        for rank in ranks {
            let p = policy();
            let d = evaluate_channel_access(rank, &p);
            assert_eq!(d.can_read, rank >= OrgRoleRank::Member);
            assert_eq!(d.can_write, rank >= OrgRoleRank::Moderator);
            assert_eq!(d.can_manage, rank >= OrgRoleRank::Admin);
            assert_eq!(d.can_create_poll, d.can_write);
            assert_eq!(d.can_manage_connectors, d.can_manage);
            assert!(!d.can_join_voice);
        }
    }
    #[test]
    fn iam_denies_every_action_without_read_or_with_invalid_ids() {
        let mut p = policy();
        p.min_read_rank = OrgRoleRank::Owner;
        p.min_write_rank = OrgRoleRank::Guest;
        p.min_manage_rank = OrgRoleRank::Guest;
        p.is_voice = true;
        let d = evaluate_channel_access(OrgRoleRank::Admin, &p);
        assert_eq!(
            d,
            ChannelAccessDecision {
                can_read: false,
                can_write: false,
                can_manage: false,
                can_create_poll: false,
                can_manage_connectors: false,
                can_join_voice: false
            }
        );
        p.channel_id = "bad\n".into();
        assert_eq!(evaluate_channel_access(OrgRoleRank::Owner, &p), d);
        p = policy();
        p.allow_polls = false;
        p.allow_connectors = false;
        p.is_voice = true;
        let d = evaluate_channel_access(OrgRoleRank::Owner, &p);
        assert!(!d.can_create_poll && !d.can_manage_connectors && d.can_join_voice);
    }
    #[test]
    fn docs_byte_limit_checked_updates_and_literal_frontmatter_export() {
        let body = "é".repeat(32_768);
        let mut doc =
            DocsPadDocument::new("pad", "channel", "Title: \"quoted\"", &body, "actor").unwrap();
        assert_eq!(doc.revision, 1);
        let export = doc.export_markdown_with_frontmatter();
        assert!(export.starts_with("---\npad_id: \"pad\"\nchannel_id: \"channel\"\ntitle: \"Title: \\\"quoted\\\"\"\nrevision: 1\nupdated_by: \"actor\"\n---\n\n"));
        assert!(export.ends_with(&body));
        assert_eq!(
            doc.validate_and_advance("New", "# Literal\n<script>not executed</script>", "next"),
            Ok(2)
        );
        assert_eq!(doc.updated_by, "next");
    }
    /// The same files are read by the Swift domain tests, so both exports stay byte-identical.
    const DOCS_PAD_VECTORS: &[(&str, &str, &str, &str)] = &[
        (
            "first-revision",
            include_str!("../tests/vectors/docs-pad/first-revision.meta"),
            include_str!("../tests/vectors/docs-pad/first-revision.body.txt"),
            include_str!("../tests/vectors/docs-pad/first-revision.export.txt"),
        ),
        (
            "later-revision",
            include_str!("../tests/vectors/docs-pad/later-revision.meta"),
            include_str!("../tests/vectors/docs-pad/later-revision.body.txt"),
            include_str!("../tests/vectors/docs-pad/later-revision.export.txt"),
        ),
        (
            "empty-body",
            include_str!("../tests/vectors/docs-pad/empty-body.meta"),
            include_str!("../tests/vectors/docs-pad/empty-body.body.txt"),
            include_str!("../tests/vectors/docs-pad/empty-body.export.txt"),
        ),
    ];
    #[test]
    fn docs_export_matches_the_shared_vectors() {
        for (name, meta, body, export) in DOCS_PAD_VECTORS {
            let field = |key: &str| {
                meta.lines()
                    .find_map(|line| line.strip_prefix(key)?.strip_prefix('='))
                    .unwrap_or_else(|| panic!("{name}: missing {key}"))
            };
            let mut doc = DocsPadDocument::new(
                field("pad_id"),
                field("channel_id"),
                field("title"),
                body,
                field("updated_by"),
            )
            .unwrap_or_else(|e| panic!("{name}: {e:?}"));
            doc.revision = field("revision").parse().unwrap();
            assert_eq!(doc.export_markdown_with_frontmatter(), *export, "{name}");
        }
    }
    #[test]
    fn docs_all_invalid_and_overflow_updates_are_transactional() {
        let mut doc = DocsPadDocument::new("pad", "channel", "Title", "body", "actor").unwrap();
        for (title, body, actor) in [
            ("", "body", "actor"),
            ("Title\n---", "body", "actor"),
            ("Title", "bad\0body", "actor"),
            ("Title", "bad\u{202e}body", "actor"),
            ("Title", &"x".repeat(65_537), "actor"),
            ("Title", "body", "bad\nactor"),
        ] {
            let old = doc.clone();
            assert!(doc.validate_and_advance(title, body, actor).is_err());
            assert_eq!(doc, old);
        }
        doc.revision = u64::MAX;
        let old = doc.clone();
        assert!(doc.validate_and_advance("New", "body", "actor").is_err());
        assert_eq!(doc, old);
        assert!(DocsPadDocument::new("bad\n", "channel", "Title", "body", "actor").is_err());
        assert!(DocsPadDocument::new("pad", "channel", &"é".repeat(61), "body", "actor").is_err());
    }
    #[test]
    fn theme_wire_bound_is_applied_to_the_whole_untrimmed_code() {
        let raw = json();
        let padded = raw.clone() + &" ".repeat(1524 - raw.len());
        let valid = code(&padded);
        assert_eq!(valid.len(), 2048);
        assert_eq!(
            decode_shareable_theme(&valid),
            Ok(curated_desktop_themes()[0].clone())
        );
        assert!(decode_shareable_theme(&(valid.clone() + " ")).is_err());
        assert!(decode_shareable_theme(&(valid + "  ")).is_err());
    }
    #[test]
    fn malformed_public_docs_values_cannot_export_unbounded_or_injected_metadata() {
        let mut doc = DocsPadDocument::new("pad", "channel", "Title", "body", "actor").unwrap();
        doc.title = "Title\n---\nforged: value".into();
        assert_eq!(doc.export_markdown_with_frontmatter(), "");
        doc.title = "Title".into();
        doc.markdown_body = "x".repeat(65_537);
        assert_eq!(doc.export_markdown_with_frontmatter(), "");
        doc.markdown_body = "body".into();
        doc.revision = 0;
        let previous = doc.clone();
        assert!(doc.validate_and_advance("Title", "body", "actor").is_err());
        assert_eq!(doc, previous);
        assert_eq!(doc.export_markdown_with_frontmatter(), "");
    }
}
