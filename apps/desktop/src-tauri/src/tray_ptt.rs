//! Deterministic native system tray indicator controller and opt-in global Push-to-Talk (`PTT`)
//! shortcut state machine.
//!
//! Security & UX invariants:
//! - Global Push-to-Talk defaults to **disabled** (`opt_in_enabled == false`) until explicit user
//!   opt-in, and resets unconditionally on workspace teardown or organisation switch.
//! - Single-character alphanumeric keys (`A`–`Z`, `0`–`9`), `Space`, punctuation keys, and
//!   Shift-only combinations (`Shift+A`) are strictly refused without at least one command
//!   modifier (`Ctrl`, `Alt`, or `Super`) so ordinary typing across the OS can never be hijacked.
//! - OS window/session chords (`Alt+F4`, `Ctrl+Q`, `Super+Q`, `Super+L`) and editing essentials
//!   (`Enter`, `Tab`, `Backspace`, `Delete`, `Escape`) are refused as reserved system bindings.

use core::fmt;
use std::collections::BTreeSet;

/// Upper bound on unread message counts accepted by the tray controller.
pub const MAX_TRAY_UNREAD_COUNT: u32 = 99_999;

/// Maximum unread count displayed verbatim before collapsing to `"99+"`.
pub const MAX_TRAY_BADGE_DIRECT: u32 = 99;

/// Maximum UTF-8 byte length of a raw Push-to-Talk key-chord expression.
pub const MAX_PTT_CHORD_BYTES: usize = 64;

/// Closed error codes for native tray and Push-to-Talk operations.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum TrayPttError {
    UnreadCountOutOfRange,
    InvalidCallState,
    InvalidMenuAction,
    PttNotOptedIn,
    PttBindingNotConfigured,
    InvalidKeyChord,
    DuplicateModifier,
    MissingTriggerKey,
    MultipleTriggerKeys,
    UnsafeTypingKeyWithoutModifier,
    ReservedSystemChord,
}

impl fmt::Display for TrayPttError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        let code = match self {
            Self::UnreadCountOutOfRange => "unread_count_out_of_range",
            Self::InvalidCallState => "invalid_call_state",
            Self::InvalidMenuAction => "invalid_menu_action",
            Self::PttNotOptedIn => "ptt_not_opted_in",
            Self::PttBindingNotConfigured => "ptt_binding_not_configured",
            Self::InvalidKeyChord => "invalid_key_chord",
            Self::DuplicateModifier => "duplicate_modifier",
            Self::MissingTriggerKey => "missing_trigger_key",
            Self::MultipleTriggerKeys => "multiple_trigger_keys",
            Self::UnsafeTypingKeyWithoutModifier => "unsafe_typing_key_without_modifier",
            Self::ReservedSystemChord => "reserved_system_chord",
        };
        f.write_str(code)
    }
}

impl std::error::Error for TrayPttError {}

/// Active real-time call modality surfaced in the desktop system tray.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum TrayCallKind {
    Voice,
    Video,
}

impl TrayCallKind {
    pub fn parse_optional(raw: &str) -> Result<Option<Self>, TrayPttError> {
        match raw {
            "none" => Ok(None),
            "voice" => Ok(Some(Self::Voice)),
            "video" => Ok(Some(Self::Video)),
            _ => Err(TrayPttError::InvalidCallState),
        }
    }

    pub const fn as_str(self) -> &'static str {
        match self {
            Self::Voice => "voice",
            Self::Video => "video",
        }
    }
}

/// Primary visual indicator selected for the native tray icon.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum TrayIndicator {
    Idle,
    Unread { count: u32, badge: String },
    Muted,
    ActiveCall { kind: TrayCallKind, muted: bool },
    SelfHostDegraded,
}

/// Immutable snapshot of the desktop tray state.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct TrayStateSnapshot {
    pub indicator: TrayIndicator,
    pub unread_count: u32,
    pub unread_badge: Option<String>,
    pub active_call: Option<TrayCallKind>,
    pub muted: bool,
    pub ptt_transmitting: bool,
    pub self_host_degraded: bool,
    pub tooltip: String,
}

/// Deterministic state container for the native system tray icon and tooltip.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct TrayController {
    unread_count: u32,
    active_call: Option<TrayCallKind>,
    muted: bool,
    self_host_degraded: bool,
}

impl TrayController {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn clear(&mut self) {
        *self = Self::default();
    }

    pub fn set_unread_count(&mut self, unread_count: u32) -> Result<(), TrayPttError> {
        if unread_count > MAX_TRAY_UNREAD_COUNT {
            return Err(TrayPttError::UnreadCountOutOfRange);
        }
        self.unread_count = unread_count;
        Ok(())
    }

    pub fn set_call_state(&mut self, active_call: Option<TrayCallKind>, muted: bool) {
        self.active_call = active_call;
        self.muted = muted;
    }

    pub fn set_muted(&mut self, muted: bool) {
        self.muted = muted;
    }

    pub fn toggle_mute(&mut self) -> bool {
        self.muted = !self.muted;
        self.muted
    }

    pub const fn unread_count(&self) -> u32 {
        self.unread_count
    }

    pub const fn is_muted(&self) -> bool {
        self.muted
    }

    pub fn set_self_host_degraded(&mut self, degraded: bool) {
        self.self_host_degraded = degraded;
    }

    pub fn update_all(
        &mut self,
        unread_count: u32,
        active_call: Option<TrayCallKind>,
        muted: bool,
        self_host_degraded: bool,
    ) -> Result<(), TrayPttError> {
        if unread_count > MAX_TRAY_UNREAD_COUNT {
            return Err(TrayPttError::UnreadCountOutOfRange);
        }
        self.unread_count = unread_count;
        self.active_call = active_call;
        self.muted = muted;
        self.self_host_degraded = self_host_degraded;
        Ok(())
    }

    pub fn snapshot(&self, ptt_transmitting: bool) -> TrayStateSnapshot {
        let unread_badge = format_unread_badge(self.unread_count);
        let effectively_muted = self.muted && !ptt_transmitting;
        let indicator = if let Some(kind) = self.active_call {
            TrayIndicator::ActiveCall {
                kind,
                muted: effectively_muted,
            }
        } else if self.self_host_degraded {
            TrayIndicator::SelfHostDegraded
        } else if effectively_muted {
            TrayIndicator::Muted
        } else if let Some(badge) = &unread_badge {
            TrayIndicator::Unread {
                count: self.unread_count,
                badge: badge.clone(),
            }
        } else {
            TrayIndicator::Idle
        };

        let tooltip = match &indicator {
            TrayIndicator::ActiveCall { kind, muted } => {
                let label = match kind {
                    TrayCallKind::Voice => "Voice call",
                    TrayCallKind::Video => "Video call",
                };
                if ptt_transmitting {
                    format!("Kodera - {label} (PTT active)")
                } else if *muted {
                    format!("Kodera - {label} (muted)")
                } else {
                    format!("Kodera - {label}")
                }
            }
            TrayIndicator::SelfHostDegraded => "Kodera - Local self-host degraded".to_owned(),
            TrayIndicator::Muted => "Kodera - Microphone muted".to_owned(),
            TrayIndicator::Unread { badge, .. } => format!("Kodera - {badge} unread"),
            TrayIndicator::Idle => "Kodera - Idle".to_owned(),
        };

        TrayStateSnapshot {
            indicator,
            unread_count: self.unread_count,
            unread_badge,
            active_call: self.active_call,
            muted: self.muted,
            ptt_transmitting,
            self_host_degraded: self.self_host_degraded,
            tooltip,
        }
    }

    /// Builds the deterministic native system tray menu (*Open Kodera*, *Toggle Mute*,
    /// *Unread Badge indicator*, *Quit*) synchronized with the current tray snapshot.
    pub fn menu_model(&self, ptt_transmitting: bool) -> TrayMenuModel {
        let snapshot = self.snapshot(ptt_transmitting);
        let mute_label = if snapshot.muted {
            "Toggle Mute (Muted - Unmute Microphone)".to_owned()
        } else {
            "Toggle Mute (Mute Microphone)".to_owned()
        };
        let unread_label = match &snapshot.unread_badge {
            Some(badge) => format!("Unread Messages: {badge}"),
            None => "Unread Messages: None".to_owned(),
        };
        let entries = vec![
            TrayMenuEntry {
                id: TrayMenuItemId::OpenKodera,
                label: "Open Kodera".to_owned(),
                enabled: true,
                checked: false,
            },
            TrayMenuEntry {
                id: TrayMenuItemId::ToggleMute,
                label: mute_label,
                enabled: true,
                checked: snapshot.muted,
            },
            TrayMenuEntry {
                id: TrayMenuItemId::UnreadIndicator,
                label: unread_label,
                enabled: false,
                checked: false,
            },
            TrayMenuEntry {
                id: TrayMenuItemId::Quit,
                label: "Quit Kodera".to_owned(),
                enabled: true,
                checked: false,
            },
        ];
        TrayMenuModel {
            entries,
            tooltip: snapshot.tooltip,
            indicator: snapshot.indicator,
            unread_badge: snapshot.unread_badge,
            muted: snapshot.muted,
        }
    }

    /// Executes a validated system tray menu action against the tray controller.
    pub fn handle_menu_action(
        &mut self,
        action: TrayMenuItemId,
        ptt_transmitting: bool,
    ) -> TrayMenuActionOutcome {
        match action {
            TrayMenuItemId::OpenKodera => TrayMenuActionOutcome::ShowAndFocusMainWindow {
                tray: self.snapshot(ptt_transmitting),
            },
            TrayMenuItemId::ToggleMute => {
                let muted = self.toggle_mute();
                TrayMenuActionOutcome::MuteToggled {
                    muted,
                    tray: self.snapshot(ptt_transmitting),
                }
            }
            TrayMenuItemId::UnreadIndicator => {
                let tray = self.snapshot(ptt_transmitting);
                TrayMenuActionOutcome::UnreadIndicatorStatus {
                    unread_count: tray.unread_count,
                    unread_badge: tray.unread_badge.clone(),
                    tray,
                }
            }
            TrayMenuItemId::Quit => TrayMenuActionOutcome::QuitRequested,
        }
    }
}

/// Canonical identifiers for the four system tray context-menu items.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum TrayMenuItemId {
    OpenKodera,
    ToggleMute,
    UnreadIndicator,
    Quit,
}

impl TrayMenuItemId {
    pub fn parse(raw: &str) -> Result<Self, TrayPttError> {
        match raw {
            "open_kodera" => Ok(Self::OpenKodera),
            "toggle_mute" => Ok(Self::ToggleMute),
            "unread_indicator" => Ok(Self::UnreadIndicator),
            "quit" => Ok(Self::Quit),
            _ => Err(TrayPttError::InvalidMenuAction),
        }
    }

    pub const fn as_str(self) -> &'static str {
        match self {
            Self::OpenKodera => "open_kodera",
            Self::ToggleMute => "toggle_mute",
            Self::UnreadIndicator => "unread_indicator",
            Self::Quit => "quit",
        }
    }
}

/// Single rendered row in the native system tray menu.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct TrayMenuEntry {
    pub id: TrayMenuItemId,
    pub label: String,
    pub enabled: bool,
    pub checked: bool,
}

/// Complete native system tray menu model synchronized with live call/unread state.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct TrayMenuModel {
    pub entries: Vec<TrayMenuEntry>,
    pub tooltip: String,
    pub indicator: TrayIndicator,
    pub unread_badge: Option<String>,
    pub muted: bool,
}

/// Deterministic host action emitted when a user selects a system tray menu item.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum TrayMenuActionOutcome {
    ShowAndFocusMainWindow {
        tray: TrayStateSnapshot,
    },
    MuteToggled {
        muted: bool,
        tray: TrayStateSnapshot,
    },
    UnreadIndicatorStatus {
        unread_count: u32,
        unread_badge: Option<String>,
        tray: TrayStateSnapshot,
    },
    QuitRequested,
}

fn format_unread_badge(unread_count: u32) -> Option<String> {
    if unread_count == 0 {
        None
    } else if unread_count > MAX_TRAY_BADGE_DIRECT {
        Some("99+".to_owned())
    } else {
        Some(unread_count.to_string())
    }
}

/// Canonical modifier keys ordered deterministically (`Ctrl`, `Alt`, `Shift`, `Super`).
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord)]
pub enum PttModifier {
    Ctrl,
    Alt,
    Shift,
    Super,
}

impl PttModifier {
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::Ctrl => "Ctrl",
            Self::Alt => "Alt",
            Self::Shift => "Shift",
            Self::Super => "Super",
        }
    }

    pub const fn is_command_modifier(self) -> bool {
        matches!(self, Self::Ctrl | Self::Alt | Self::Super)
    }

    fn parse(token: &str) -> Option<Self> {
        match token {
            "Ctrl" | "Control" | "CommandOrControl" | "ctrl" | "control" => Some(Self::Ctrl),
            "Alt" | "Option" | "alt" | "option" => Some(Self::Alt),
            "Shift" | "shift" => Some(Self::Shift),
            "Super" | "Meta" | "Cmd" | "Command" | "super" | "meta" | "cmd" => Some(Self::Super),
            _ => None,
        }
    }
}

/// Validated non-modifier trigger key for global Push-to-Talk.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum PttTriggerKey {
    Letter(char),
    Digit(char),
    Space,
    Backquote,
    Minus,
    Equal,
    BracketLeft,
    BracketRight,
    Backslash,
    Semicolon,
    Quote,
    Comma,
    Period,
    Slash,
    CapsLock,
    ScrollLock,
    Pause,
    Insert,
    Function(u8),
}

impl PttTriggerKey {
    /// Returns `true` when the key can only be bound globally alongside `Ctrl`, `Alt`, or `Super`.
    pub const fn requires_command_modifier(self) -> bool {
        match self {
            Self::Function(n) if n >= 13 => false,
            Self::Pause | Self::ScrollLock => false,
            _ => true,
        }
    }

    pub fn canonical_label(self) -> String {
        match self {
            Self::Letter(ch) | Self::Digit(ch) => ch.to_string(),
            Self::Space => "Space".to_owned(),
            Self::Backquote => "Backquote".to_owned(),
            Self::Minus => "Minus".to_owned(),
            Self::Equal => "Equal".to_owned(),
            Self::BracketLeft => "BracketLeft".to_owned(),
            Self::BracketRight => "BracketRight".to_owned(),
            Self::Backslash => "Backslash".to_owned(),
            Self::Semicolon => "Semicolon".to_owned(),
            Self::Quote => "Quote".to_owned(),
            Self::Comma => "Comma".to_owned(),
            Self::Period => "Period".to_owned(),
            Self::Slash => "Slash".to_owned(),
            Self::CapsLock => "CapsLock".to_owned(),
            Self::ScrollLock => "ScrollLock".to_owned(),
            Self::Pause => "Pause".to_owned(),
            Self::Insert => "Insert".to_owned(),
            Self::Function(n) => format!("F{n}"),
        }
    }

    fn parse(token: &str) -> Result<Self, TrayPttError> {
        if matches!(
            token.to_ascii_lowercase().as_str(),
            "enter" | "return" | "tab" | "backspace" | "delete" | "del" | "escape" | "esc"
        ) {
            return Err(TrayPttError::ReservedSystemChord);
        }
        if token.len() == 1 {
            let ch = token.as_bytes()[0] as char;
            if ch.is_ascii_alphabetic() {
                return Ok(Self::Letter(ch.to_ascii_uppercase()));
            }
            if ch.is_ascii_digit() {
                return Ok(Self::Digit(ch));
            }
            return match ch {
                '`' => Ok(Self::Backquote),
                '-' => Ok(Self::Minus),
                '=' => Ok(Self::Equal),
                '[' => Ok(Self::BracketLeft),
                ']' => Ok(Self::BracketRight),
                '\\' => Ok(Self::Backslash),
                ';' => Ok(Self::Semicolon),
                '\'' => Ok(Self::Quote),
                ',' => Ok(Self::Comma),
                '.' => Ok(Self::Period),
                '/' => Ok(Self::Slash),
                _ => Err(TrayPttError::InvalidKeyChord),
            };
        }
        if let Some(rest) = token.strip_prefix('F').or_else(|| token.strip_prefix('f')) {
            if let Ok(num) = rest.parse::<u8>() {
                if (1..=24).contains(&num) && !rest.starts_with('0') {
                    return Ok(Self::Function(num));
                }
            }
        }
        match token.to_ascii_lowercase().as_str() {
            "space" => Ok(Self::Space),
            "backquote" => Ok(Self::Backquote),
            "minus" => Ok(Self::Minus),
            "equal" => Ok(Self::Equal),
            "bracketleft" => Ok(Self::BracketLeft),
            "bracketright" => Ok(Self::BracketRight),
            "backslash" => Ok(Self::Backslash),
            "semicolon" => Ok(Self::Semicolon),
            "quote" => Ok(Self::Quote),
            "comma" => Ok(Self::Comma),
            "period" => Ok(Self::Period),
            "slash" => Ok(Self::Slash),
            "capslock" => Ok(Self::CapsLock),
            "scrolllock" => Ok(Self::ScrollLock),
            "pause" => Ok(Self::Pause),
            "insert" => Ok(Self::Insert),
            _ => Err(TrayPttError::InvalidKeyChord),
        }
    }
}

/// Validated, canonicalized global Push-to-Talk key chord.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PttKeyChord {
    modifiers: BTreeSet<PttModifier>,
    trigger: PttTriggerKey,
    canonical: String,
}

impl PttKeyChord {
    pub fn parse(raw: &str) -> Result<Self, TrayPttError> {
        if raw.is_empty() || raw.len() > MAX_PTT_CHORD_BYTES || !raw.is_ascii() {
            return Err(TrayPttError::InvalidKeyChord);
        }
        if raw
            .bytes()
            .any(|b| b.is_ascii_control() || b.is_ascii_whitespace())
        {
            return Err(TrayPttError::InvalidKeyChord);
        }

        let mut modifiers = BTreeSet::new();
        let mut trigger: Option<PttTriggerKey> = None;

        for part in raw.split('+') {
            if part.is_empty() {
                return Err(TrayPttError::InvalidKeyChord);
            }
            if let Some(modifier) = PttModifier::parse(part) {
                if !modifiers.insert(modifier) {
                    return Err(TrayPttError::DuplicateModifier);
                }
            } else {
                let parsed_trigger = PttTriggerKey::parse(part)?;
                if trigger.is_some() {
                    return Err(TrayPttError::MultipleTriggerKeys);
                }
                trigger = Some(parsed_trigger);
            }
        }

        let Some(trigger_key) = trigger else {
            return Err(TrayPttError::MissingTriggerKey);
        };

        let has_command_modifier = modifiers
            .iter()
            .copied()
            .any(PttModifier::is_command_modifier);
        if trigger_key.requires_command_modifier() && !has_command_modifier {
            return Err(TrayPttError::UnsafeTypingKeyWithoutModifier);
        }

        if is_reserved_os_chord(&modifiers, trigger_key) {
            return Err(TrayPttError::ReservedSystemChord);
        }

        let mut parts: Vec<String> = modifiers.iter().map(|m| (*m).as_str().to_owned()).collect();
        parts.push(trigger_key.canonical_label());
        let canonical = parts.join("+");

        Ok(Self {
            modifiers,
            trigger: trigger_key,
            canonical,
        })
    }

    pub fn modifiers(&self) -> &BTreeSet<PttModifier> {
        &self.modifiers
    }

    pub fn trigger(&self) -> PttTriggerKey {
        self.trigger
    }

    pub fn as_str(&self) -> &str {
        &self.canonical
    }
}

fn is_reserved_os_chord(modifiers: &BTreeSet<PttModifier>, trigger: PttTriggerKey) -> bool {
    let only = |expected: &[PttModifier]| {
        modifiers.len() == expected.len() && expected.iter().all(|m| modifiers.contains(m))
    };
    matches!(
        (trigger, modifiers.len()),
        (PttTriggerKey::Function(4), _) if only(&[PttModifier::Alt])
    ) || (trigger == PttTriggerKey::Letter('Q')
        && (only(&[PttModifier::Ctrl]) || only(&[PttModifier::Super])))
        || (trigger == PttTriggerKey::Letter('L') && only(&[PttModifier::Super]))
        || (trigger == PttTriggerKey::Letter('W')
            && (only(&[PttModifier::Ctrl]) || only(&[PttModifier::Super])))
}

/// Live press/release state of the Push-to-Talk microphone gate.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum PttTransmissionState {
    Inactive,
    Transmitting { since_ms: u64 },
}

/// Serializable/inspectable snapshot of the Push-to-Talk controller.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PttStateSnapshot {
    pub opt_in_enabled: bool,
    pub binding: Option<String>,
    pub transmission: PttTransmissionState,
}

/// Deterministic Push-to-Talk state machine. Defaults to disabled (`opt_in_enabled: false`).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PttController {
    opt_in_enabled: bool,
    binding: Option<PttKeyChord>,
    transmission: PttTransmissionState,
}

impl Default for PttController {
    fn default() -> Self {
        Self::new()
    }
}

impl PttController {
    pub const fn new() -> Self {
        Self {
            opt_in_enabled: false,
            binding: None,
            transmission: PttTransmissionState::Inactive,
        }
    }

    pub fn clear(&mut self) {
        *self = Self::new();
    }

    pub fn force_release(&mut self) {
        self.transmission = PttTransmissionState::Inactive;
    }

    pub const fn is_opted_in(&self) -> bool {
        self.opt_in_enabled
    }

    pub const fn is_transmitting(&self) -> bool {
        matches!(self.transmission, PttTransmissionState::Transmitting { .. })
    }

    pub fn binding(&self) -> Option<&PttKeyChord> {
        self.binding.as_ref()
    }

    /// Configures opt-in state and optional key-chord binding atomically.
    ///
    /// - Supplying a chord while `opt_in == false` is refused (`PttNotOptedIn`) without mutating state.
    /// - Setting `opt_in == false` with `raw_chord == None` releases active transmission and clears the binding.
    /// - Setting `opt_in == true` with `raw_chord == None` clears the binding and releases active transmission while keeping opt-in enabled.
    /// - Setting `opt_in == true` with `Some(chord)` validates the chord first; invalid chords leave existing state intact.
    pub fn configure(
        &mut self,
        opt_in: bool,
        raw_chord: Option<&str>,
    ) -> Result<PttStateSnapshot, TrayPttError> {
        if !opt_in {
            if raw_chord.is_some() {
                return Err(TrayPttError::PttNotOptedIn);
            }
            self.clear();
            return Ok(self.snapshot());
        }
        if let Some(raw) = raw_chord {
            let chord = PttKeyChord::parse(raw)?;
            self.opt_in_enabled = true;
            self.binding = Some(chord);
            self.transmission = PttTransmissionState::Inactive;
        } else {
            self.opt_in_enabled = true;
            self.binding = None;
            self.transmission = PttTransmissionState::Inactive;
        }
        Ok(self.snapshot())
    }

    pub fn register_binding(&mut self, raw_chord: &str) -> Result<PttKeyChord, TrayPttError> {
        if !self.opt_in_enabled {
            return Err(TrayPttError::PttNotOptedIn);
        }
        let chord = PttKeyChord::parse(raw_chord)?;
        self.binding = Some(chord.clone());
        self.transmission = PttTransmissionState::Inactive;
        Ok(chord)
    }

    pub fn press(&mut self, now_ms: u64) -> Result<PttStateSnapshot, TrayPttError> {
        if !self.opt_in_enabled {
            return Err(TrayPttError::PttNotOptedIn);
        }
        if self.binding.is_none() {
            return Err(TrayPttError::PttBindingNotConfigured);
        }
        if matches!(self.transmission, PttTransmissionState::Inactive) {
            self.transmission = PttTransmissionState::Transmitting { since_ms: now_ms };
        }
        Ok(self.snapshot())
    }

    pub fn release(&mut self) -> Result<PttStateSnapshot, TrayPttError> {
        if !self.opt_in_enabled {
            return Err(TrayPttError::PttNotOptedIn);
        }
        if self.binding.is_none() {
            return Err(TrayPttError::PttBindingNotConfigured);
        }
        self.transmission = PttTransmissionState::Inactive;
        Ok(self.snapshot())
    }

    pub fn snapshot(&self) -> PttStateSnapshot {
        PttStateSnapshot {
            opt_in_enabled: self.opt_in_enabled,
            binding: self.binding.as_ref().map(|c| c.as_str().to_owned()),
            transmission: self.transmission,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn tray_priority_resolves_idle_unread_muted_degraded_and_calls_deterministically() {
        let mut tray = TrayController::new();
        assert_eq!(tray.snapshot(false).indicator, TrayIndicator::Idle);
        assert_eq!(tray.snapshot(false).tooltip, "Kodera - Idle");

        tray.set_unread_count(5).unwrap();
        assert_eq!(
            tray.snapshot(false).indicator,
            TrayIndicator::Unread {
                count: 5,
                badge: "5".to_owned(),
            }
        );

        tray.set_unread_count(140).unwrap();
        assert_eq!(tray.snapshot(false).unread_badge, Some("99+".to_owned()));

        tray.set_muted(true);
        assert_eq!(tray.snapshot(false).indicator, TrayIndicator::Muted);

        tray.set_self_host_degraded(true);
        assert_eq!(
            tray.snapshot(false).indicator,
            TrayIndicator::SelfHostDegraded
        );

        tray.set_call_state(Some(TrayCallKind::Voice), true);
        let in_muted_call = tray.snapshot(false);
        assert_eq!(
            in_muted_call.indicator,
            TrayIndicator::ActiveCall {
                kind: TrayCallKind::Voice,
                muted: true,
            }
        );
        assert_eq!(in_muted_call.tooltip, "Kodera - Voice call (muted)");

        // Active PTT overrides mute indicator during transmission without losing stored mute flag.
        let ptt_live = tray.snapshot(true);
        assert_eq!(
            ptt_live.indicator,
            TrayIndicator::ActiveCall {
                kind: TrayCallKind::Voice,
                muted: false,
            }
        );
        assert!(ptt_live.muted && ptt_live.ptt_transmitting);
        assert_eq!(ptt_live.tooltip, "Kodera - Voice call (PTT active)");

        tray.set_call_state(Some(TrayCallKind::Video), false);
        assert_eq!(
            tray.snapshot(false).indicator,
            TrayIndicator::ActiveCall {
                kind: TrayCallKind::Video,
                muted: false,
            }
        );
        assert_eq!(
            tray.set_unread_count(MAX_TRAY_UNREAD_COUNT + 1),
            Err(TrayPttError::UnreadCountOutOfRange)
        );
    }

    #[test]
    fn ptt_defaults_disabled_and_rejects_typing_hijack_bindings() {
        let mut ptt = PttController::new();
        assert!(!ptt.is_opted_in());
        assert!(!ptt.is_transmitting());
        assert_eq!(ptt.press(100), Err(TrayPttError::PttNotOptedIn));
        assert_eq!(
            ptt.register_binding("Ctrl+Space"),
            Err(TrayPttError::PttNotOptedIn)
        );
        assert_eq!(
            ptt.configure(false, Some("Ctrl+Space")),
            Err(TrayPttError::PttNotOptedIn)
        );

        // Single-character alphanumeric keys and Shift-only typing keys are refused.
        for unsafe_chord in [
            "a",
            "Z",
            "0",
            "9",
            "Space",
            "Shift+A",
            "Shift+9",
            "Shift+Space",
            "Backquote",
            "F5",
        ] {
            assert_eq!(
                PttKeyChord::parse(unsafe_chord),
                Err(TrayPttError::UnsafeTypingKeyWithoutModifier),
                "expected typing guard refusal for {unsafe_chord}"
            );
        }

        // System/editing chords are refused.
        for reserved in [
            "Enter",
            "Escape",
            "Tab",
            "Backspace",
            "Alt+F4",
            "Ctrl+Q",
            "Super+W",
        ] {
            assert_eq!(
                PttKeyChord::parse(reserved),
                Err(TrayPttError::ReservedSystemChord),
                "expected reserved refusal for {reserved}"
            );
        }

        // Malformed chords, duplicate modifiers, missing or multiple triggers fail closed.
        assert_eq!(
            PttKeyChord::parse("Ctrl+Control+Space"),
            Err(TrayPttError::DuplicateModifier)
        );
        assert_eq!(
            PttKeyChord::parse("Ctrl+Shift"),
            Err(TrayPttError::MissingTriggerKey)
        );
        assert_eq!(
            PttKeyChord::parse("Ctrl+A+B"),
            Err(TrayPttError::MultipleTriggerKeys)
        );
    }

    #[test]
    fn ptt_unbinding_while_opted_in_releases_active_transmission() {
        let mut ptt = PttController::new();
        ptt.configure(true, Some("Ctrl+Space")).unwrap();
        ptt.press(1_000).unwrap();
        assert!(ptt.is_transmitting());

        let unbound = ptt.configure(true, None).unwrap();
        assert!(unbound.opt_in_enabled);
        assert!(unbound.binding.is_none());
        assert_eq!(unbound.transmission, PttTransmissionState::Inactive);
        assert!(ptt.is_opted_in());
        assert!(ptt.binding().is_none());
        assert!(!ptt.is_transmitting());
        assert_eq!(ptt.press(2_000), Err(TrayPttError::PttBindingNotConfigured));
        assert_eq!(ptt.release(), Err(TrayPttError::PttBindingNotConfigured));
        assert_eq!(ptt.snapshot(), unbound);

        ptt.register_binding("Ctrl+Space").unwrap();
        ptt.press(3_000).unwrap();
        assert!(ptt.is_transmitting());
        ptt.release().unwrap();
        assert!(!ptt.is_transmitting());
    }

    #[test]
    fn ptt_opt_in_registration_press_key_repeat_release_and_opt_out_lifecycle() {
        let mut ptt = PttController::new();
        let configured = ptt.configure(true, Some("Shift+Control+space")).unwrap();
        assert!(configured.opt_in_enabled);
        assert_eq!(configured.binding.as_deref(), Some("Ctrl+Shift+Space"));
        assert_eq!(configured.transmission, PttTransmissionState::Inactive);

        // Dedicated extended function keys (e.g. foot-pedal F13) are also permitted after opt-in.
        assert_eq!(PttKeyChord::parse("F13").unwrap().as_str(), "F13");

        // Invalid replacement leaves existing valid binding intact.
        assert_eq!(
            ptt.configure(true, Some("v")),
            Err(TrayPttError::UnsafeTypingKeyWithoutModifier)
        );
        assert_eq!(ptt.snapshot().binding.as_deref(), Some("Ctrl+Shift+Space"));

        // Press -> key-repeat preserves initial timestamp -> release -> opt-out clears.
        let pressed = ptt.press(1_500).unwrap();
        assert_eq!(
            pressed.transmission,
            PttTransmissionState::Transmitting { since_ms: 1_500 }
        );
        let repeat = ptt.press(1_650).unwrap();
        assert_eq!(
            repeat.transmission,
            PttTransmissionState::Transmitting { since_ms: 1_500 }
        );

        let released = ptt.release().unwrap();
        assert_eq!(released.transmission, PttTransmissionState::Inactive);

        // Opting out while transmitting immediately releases and clears binding.
        ptt.press(2_000).unwrap();
        assert!(ptt.is_transmitting());
        let disabled = ptt.configure(false, None).unwrap();
        assert!(!disabled.opt_in_enabled);
        assert!(disabled.binding.is_none());
        assert_eq!(disabled.transmission, PttTransmissionState::Inactive);
    }

    #[test]
    fn tray_menu_exposes_open_toggle_mute_unread_badge_and_quit_actions() {
        let mut tray = TrayController::new();
        let initial_menu = tray.menu_model(false);
        assert_eq!(initial_menu.entries.len(), 4);
        assert_eq!(initial_menu.entries[0].id, TrayMenuItemId::OpenKodera);
        assert_eq!(initial_menu.entries[0].label, "Open Kodera");
        assert!(initial_menu.entries[0].enabled);
        assert_eq!(initial_menu.entries[1].id, TrayMenuItemId::ToggleMute);
        assert!(!initial_menu.entries[1].checked);
        assert_eq!(initial_menu.entries[2].id, TrayMenuItemId::UnreadIndicator);
        assert_eq!(initial_menu.entries[2].label, "Unread Messages: None");
        assert!(!initial_menu.entries[2].enabled);
        assert_eq!(initial_menu.entries[3].id, TrayMenuItemId::Quit);
        assert_eq!(initial_menu.entries[3].label, "Quit Kodera");

        tray.set_unread_count(125).unwrap();
        let badge_menu = tray.menu_model(false);
        assert_eq!(badge_menu.unread_badge.as_deref(), Some("99+"));
        assert_eq!(badge_menu.entries[2].label, "Unread Messages: 99+");

        assert!(matches!(
            tray.handle_menu_action(TrayMenuItemId::OpenKodera, false),
            TrayMenuActionOutcome::ShowAndFocusMainWindow { .. }
        ));
        let TrayMenuActionOutcome::MuteToggled { muted, tray: snap } =
            tray.handle_menu_action(TrayMenuItemId::ToggleMute, false)
        else {
            panic!("expected MuteToggled");
        };
        assert!(muted && snap.muted);
        assert!(tray.menu_model(false).entries[1].checked);

        let TrayMenuActionOutcome::UnreadIndicatorStatus {
            unread_count,
            unread_badge,
            ..
        } = tray.handle_menu_action(TrayMenuItemId::UnreadIndicator, false)
        else {
            panic!("expected UnreadIndicatorStatus");
        };
        assert_eq!(unread_count, 125);
        assert_eq!(unread_badge.as_deref(), Some("99+"));

        assert_eq!(
            tray.handle_menu_action(TrayMenuItemId::Quit, false),
            TrayMenuActionOutcome::QuitRequested
        );
        assert_eq!(
            TrayMenuItemId::parse("invalid"),
            Err(TrayPttError::InvalidMenuAction)
        );
    }
}
