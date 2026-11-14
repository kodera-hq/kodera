//! Native desktop notification and dock/taskbar unread badge bridge.
//!
//! Security & UX invariants:
//! - Notification titles and preview bodies reject ASCII control characters and Unicode
//!   bidirectional override / formatting characters (`U+202A`..=`U+202E`, `U+2066`..=`U+2069`,
//!   `U+200E`, `U+200F`, `U+FEFF`) so right-to-left spoofing cannot disguise sender names or links.
//! - Optional click-through `route_uri` targets are validated through
//!   [`crate::deeplink::route_deep_link`] against the active organisation's
//!   [`crate::deeplink::DeepLinkAdmissionPolicy`]; dangerous schemes (`javascript:`, `data:`,
//!   `file:`) and non-allowlisted origins fail closed before queueing.
//! - When `redact_preview` is enabled (lock-screen / confidential mode), the OS banner body is
//!   replaced with `"New message in Kodera"` so room content never reaches shared displays.
//! - Dock/taskbar unread counts share the tray bound (`<= 99_999`) and collapse above `99` to
//!   `"99+"`.

use crate::deeplink::{route_deep_link, DeepLinkAdmissionPolicy, DeepLinkError};
use crate::tray_ptt::{MAX_TRAY_BADGE_DIRECT, MAX_TRAY_UNREAD_COUNT};
use core::fmt;
use std::collections::VecDeque;

/// Maximum UTF-8 byte length of a desktop notification title.
pub const MAX_NOTIFICATION_TITLE_BYTES: usize = 120;

/// Maximum UTF-8 byte length of a desktop notification body.
pub const MAX_NOTIFICATION_BODY_BYTES: usize = 512;

/// Maximum number of recent notifications retained in the bounded session history.
pub const MAX_NOTIFICATION_HISTORY: usize = 64;

/// Generic preview text emitted when `redact_preview` is enabled.
pub const REDACTED_NOTIFICATION_PREVIEW: &str = "New message in Kodera";

/// Closed refusal codes for native notification and dock/taskbar badge operations.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum NotificationError {
    EmptyTitle,
    TitleTooLong,
    EmptyBody,
    BodyTooLong,
    ForbiddenCharacters,
    UnreadCountOutOfRange,
    InvalidRouteUri(DeepLinkError),
}

impl fmt::Display for NotificationError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::EmptyTitle => f.write_str("empty_title"),
            Self::TitleTooLong => f.write_str("title_too_long"),
            Self::EmptyBody => f.write_str("empty_body"),
            Self::BodyTooLong => f.write_str("body_too_long"),
            Self::ForbiddenCharacters => f.write_str("forbidden_characters"),
            Self::UnreadCountOutOfRange => f.write_str("unread_count_out_of_range"),
            Self::InvalidRouteUri(err) => write!(f, "invalid_route_uri:{err}"),
        }
    }
}

impl std::error::Error for NotificationError {}

/// Dock (macOS) / Taskbar (Windows & Linux) unread badge state synchronized with the system tray.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct DockBadgeSnapshot {
    pub unread_count: u32,
    pub badge_label: Option<String>,
    pub visible: bool,
}

impl DockBadgeSnapshot {
    pub fn from_unread_count(unread_count: u32) -> Result<Self, NotificationError> {
        if unread_count > MAX_TRAY_UNREAD_COUNT {
            return Err(NotificationError::UnreadCountOutOfRange);
        }
        let badge_label = if unread_count == 0 {
            None
        } else if unread_count > MAX_TRAY_BADGE_DIRECT {
            Some("99+".to_owned())
        } else {
            Some(unread_count.to_string())
        };
        Ok(Self {
            unread_count,
            visible: badge_label.is_some(),
            badge_label,
        })
    }
}

/// Validated input parameters for dispatching a native desktop notification.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DesktopNotificationRequest {
    pub title: String,
    pub body: String,
    pub route_uri: Option<String>,
    pub redact_preview: bool,
}

/// Sanitized desktop notification outcome delivered (or suppressed under Do Not Disturb).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DispatchedNotification {
    pub notification_id: u64,
    pub title: String,
    pub body: String,
    pub canonical_route_uri: Option<String>,
    pub redacted: bool,
    pub suppressed_by_dnd: bool,
}

/// Bounded organisation-scoped desktop notification and dock/taskbar badge controller.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct NotificationCenter {
    dock_badge: DockBadgeSnapshot,
    do_not_disturb: bool,
    next_id: u64,
    delivered: VecDeque<DispatchedNotification>,
}

impl NotificationCenter {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn clear(&mut self) {
        *self = Self::default();
    }

    pub fn set_do_not_disturb(&mut self, enabled: bool) {
        self.do_not_disturb = enabled;
    }

    pub const fn is_do_not_disturb(&self) -> bool {
        self.do_not_disturb
    }

    pub fn set_unread_count(
        &mut self,
        unread_count: u32,
    ) -> Result<DockBadgeSnapshot, NotificationError> {
        let snapshot = DockBadgeSnapshot::from_unread_count(unread_count)?;
        self.dock_badge = snapshot.clone();
        Ok(snapshot)
    }

    pub fn dock_badge(&self) -> &DockBadgeSnapshot {
        &self.dock_badge
    }

    pub fn recent_notifications(&self) -> &VecDeque<DispatchedNotification> {
        &self.delivered
    }

    pub fn dispatch(
        &mut self,
        request: &DesktopNotificationRequest,
        deep_link_policy: &DeepLinkAdmissionPolicy,
    ) -> Result<DispatchedNotification, NotificationError> {
        let title = sanitize_notification_text(
            &request.title,
            MAX_NOTIFICATION_TITLE_BYTES,
            NotificationError::EmptyTitle,
            NotificationError::TitleTooLong,
        )?;
        let validated_body = sanitize_notification_text(
            &request.body,
            MAX_NOTIFICATION_BODY_BYTES,
            NotificationError::EmptyBody,
            NotificationError::BodyTooLong,
        )?;
        let canonical_route_uri = match &request.route_uri {
            Some(raw_uri) => {
                let admitted = route_deep_link(raw_uri, deep_link_policy)
                    .map_err(NotificationError::InvalidRouteUri)?;
                Some(admitted.canonical_uri().to_owned())
            }
            None => None,
        };

        let body = if request.redact_preview {
            REDACTED_NOTIFICATION_PREVIEW.to_owned()
        } else {
            validated_body
        };

        self.next_id = self.next_id.saturating_add(1);
        let dispatched = DispatchedNotification {
            notification_id: self.next_id,
            title,
            body,
            canonical_route_uri,
            redacted: request.redact_preview,
            suppressed_by_dnd: self.do_not_disturb,
        };

        if !dispatched.suppressed_by_dnd {
            if self.delivered.len() >= MAX_NOTIFICATION_HISTORY {
                self.delivered.pop_front();
            }
            self.delivered.push_back(dispatched.clone());
        }
        Ok(dispatched)
    }
}

fn sanitize_notification_text(
    raw: &str,
    max_bytes: usize,
    empty_err: NotificationError,
    len_err: NotificationError,
) -> Result<String, NotificationError> {
    if raw.chars().any(is_forbidden_notification_char) {
        return Err(NotificationError::ForbiddenCharacters);
    }
    let trimmed = raw.trim();
    if trimmed.is_empty() {
        return Err(empty_err);
    }
    if trimmed.len() > max_bytes {
        return Err(len_err);
    }
    Ok(trimmed.to_owned())
}

fn is_forbidden_notification_char(ch: char) -> bool {
    ch.is_control()
        || matches!(
            ch,
            '\u{200E}'
                | '\u{200F}'
                | '\u{202A}'..='\u{202E}'
                | '\u{2066}'..='\u{2069}'
                | '\u{FEFF}'
        )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn dispatches_sanitized_notifications_redacts_previews_and_bounds_queue() {
        let policy = DeepLinkAdmissionPolicy::kodera_default();
        let mut center = NotificationCenter::new();

        let badge = center.set_unread_count(7).unwrap();
        assert_eq!(badge.badge_label.as_deref(), Some("7"));
        assert!(badge.visible);
        assert_eq!(
            center.set_unread_count(250).unwrap().badge_label.as_deref(),
            Some("99+")
        );
        assert!(!center.set_unread_count(0).unwrap().visible);

        let sent = center
            .dispatch(
                &DesktopNotificationRequest {
                    title: "  #ops — Alice  ".to_owned(),
                    body: "Deployment check completed".to_owned(),
                    route_uri: Some("kodera://workspace/acme-ops/ops".to_owned()),
                    redact_preview: false,
                },
                &policy,
            )
            .unwrap();
        assert_eq!(sent.notification_id, 1);
        assert_eq!(sent.title, "#ops — Alice");
        assert_eq!(sent.body, "Deployment check completed");
        assert_eq!(
            sent.canonical_route_uri.as_deref(),
            Some("kodera://workspace/acme-ops/ops")
        );
        assert!(!sent.redacted && !sent.suppressed_by_dnd);

        let redacted = center
            .dispatch(
                &DesktopNotificationRequest {
                    title: "Direct message".to_owned(),
                    body: "Sensitive room snippet".to_owned(),
                    route_uri: None,
                    redact_preview: true,
                },
                &policy,
            )
            .unwrap();
        assert!(redacted.redacted);
        assert_eq!(redacted.body, REDACTED_NOTIFICATION_PREVIEW);

        center.set_do_not_disturb(true);
        let muted = center
            .dispatch(
                &DesktopNotificationRequest {
                    title: "Quiet channel".to_owned(),
                    body: "Suppressed while DND active".to_owned(),
                    route_uri: None,
                    redact_preview: false,
                },
                &policy,
            )
            .unwrap();
        assert!(muted.suppressed_by_dnd);
        assert_eq!(center.recent_notifications().len(), 2);

        center.set_do_not_disturb(false);
        for idx in 0..(MAX_NOTIFICATION_HISTORY + 5) {
            center
                .dispatch(
                    &DesktopNotificationRequest {
                        title: format!("Title {idx}"),
                        body: "Body".to_owned(),
                        route_uri: None,
                        redact_preview: false,
                    },
                    &policy,
                )
                .unwrap();
        }
        assert_eq!(
            center.recent_notifications().len(),
            MAX_NOTIFICATION_HISTORY
        );
    }

    #[test]
    fn rejects_bidi_spoofing_control_chars_and_malicious_route_uris() {
        let policy = DeepLinkAdmissionPolicy::kodera_default();
        let mut center = NotificationCenter::new();

        for bad_title in ["Alice\u{202E}txt.exe", "Line1\nLine2", "Null\0Byte"] {
            assert_eq!(
                center.dispatch(
                    &DesktopNotificationRequest {
                        title: bad_title.to_owned(),
                        body: "Hello".to_owned(),
                        route_uri: None,
                        redact_preview: false,
                    },
                    &policy,
                ),
                Err(NotificationError::ForbiddenCharacters)
            );
        }

        for bad_uri in [
            "javascript:alert(1)",
            "data:text/html,<script>alert(1)</script>",
            "file:///etc/passwd",
            "https://evil.example.org/phish",
            "matrix:r/ops:evil.example.org?action=join",
        ] {
            assert!(matches!(
                center.dispatch(
                    &DesktopNotificationRequest {
                        title: "Alert".to_owned(),
                        body: "Check channel".to_owned(),
                        route_uri: Some(bad_uri.to_owned()),
                        redact_preview: false,
                    },
                    &policy,
                ),
                Err(NotificationError::InvalidRouteUri(_))
            ));
        }
        assert!(center.recent_notifications().is_empty());
    }
}
