//! Validated screen-share surface and audio capture preference controller for Kodera Desktop.
//!
//! Security & UX invariants:
//! - System-audio loopback capture defaults to **disabled** (`system_audio_loopback == false`)
//!   until explicit user opt-in, preventing unintended desktop audio broadcast when sharing a
//!   screen or window.
//! - Local microphone noise suppression defaults to **enabled** (`noise_suppression == true`).
//! - Preferred audio input/output device identifiers are bounded (`<= 128` bytes), printable ASCII
//!   only, validated transactionally, and reset unconditionally on workspace teardown or
//!   organisation switch so device identifiers never leak across workspaces.

use core::fmt;

/// Maximum UTF-8 byte length of a preferred audio input or output device identifier.
pub const MAX_MEDIA_DEVICE_ID_BYTES: usize = 128;

/// Closed refusal codes for screen-share and audio capture configuration.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum MediaCaptureError {
    InvalidScreenShareSurface,
    InvalidAudioInputDeviceId,
    InvalidAudioOutputDeviceId,
}

impl fmt::Display for MediaCaptureError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        let code = match self {
            Self::InvalidScreenShareSurface => "invalid_screen_share_surface",
            Self::InvalidAudioInputDeviceId => "invalid_audio_input_device_id",
            Self::InvalidAudioOutputDeviceId => "invalid_audio_output_device_id",
        };
        f.write_str(code)
    }
}

impl std::error::Error for MediaCaptureError {}

/// Preferred screen-capture surface category presented when starting a room screen share.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub enum ScreenShareSurface {
    #[default]
    Monitor,
    Window,
    BrowserTab,
}

impl ScreenShareSurface {
    pub fn parse(raw: &str) -> Result<Self, MediaCaptureError> {
        match raw {
            "monitor" => Ok(Self::Monitor),
            "window" => Ok(Self::Window),
            "browser_tab" => Ok(Self::BrowserTab),
            _ => Err(MediaCaptureError::InvalidScreenShareSurface),
        }
    }

    pub const fn as_str(self) -> &'static str {
        match self {
            Self::Monitor => "monitor",
            Self::Window => "window",
            Self::BrowserTab => "browser_tab",
        }
    }
}

/// Immutable snapshot of desktop screen-share and audio device preferences.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct MediaCaptureStateSnapshot {
    pub preferred_surface: ScreenShareSurface,
    pub system_audio_loopback: bool,
    pub noise_suppression: bool,
    pub preferred_audio_input_id: Option<String>,
    pub preferred_audio_output_id: Option<String>,
}

/// Deterministic desktop media-capture preference controller.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct MediaCaptureController {
    preferred_surface: ScreenShareSurface,
    system_audio_loopback: bool,
    noise_suppression: bool,
    preferred_audio_input_id: Option<String>,
    preferred_audio_output_id: Option<String>,
}

impl Default for MediaCaptureController {
    fn default() -> Self {
        Self::new()
    }
}

impl MediaCaptureController {
    pub const fn new() -> Self {
        Self {
            preferred_surface: ScreenShareSurface::Monitor,
            system_audio_loopback: false,
            noise_suppression: true,
            preferred_audio_input_id: None,
            preferred_audio_output_id: None,
        }
    }

    pub fn clear(&mut self) {
        *self = Self::new();
    }

    pub fn configure(
        &mut self,
        preferred_surface: ScreenShareSurface,
        system_audio_loopback: bool,
        noise_suppression: bool,
        preferred_audio_input_id: Option<&str>,
        preferred_audio_output_id: Option<&str>,
    ) -> Result<MediaCaptureStateSnapshot, MediaCaptureError> {
        let validated_input = match preferred_audio_input_id {
            Some(raw) => Some(validate_device_id(
                raw,
                MediaCaptureError::InvalidAudioInputDeviceId,
            )?),
            None => None,
        };
        let validated_output = match preferred_audio_output_id {
            Some(raw) => Some(validate_device_id(
                raw,
                MediaCaptureError::InvalidAudioOutputDeviceId,
            )?),
            None => None,
        };

        self.preferred_surface = preferred_surface;
        self.system_audio_loopback = system_audio_loopback;
        self.noise_suppression = noise_suppression;
        self.preferred_audio_input_id = validated_input;
        self.preferred_audio_output_id = validated_output;
        Ok(self.snapshot())
    }

    pub fn snapshot(&self) -> MediaCaptureStateSnapshot {
        MediaCaptureStateSnapshot {
            preferred_surface: self.preferred_surface,
            system_audio_loopback: self.system_audio_loopback,
            noise_suppression: self.noise_suppression,
            preferred_audio_input_id: self.preferred_audio_input_id.clone(),
            preferred_audio_output_id: self.preferred_audio_output_id.clone(),
        }
    }
}

fn validate_device_id(raw: &str, err: MediaCaptureError) -> Result<String, MediaCaptureError> {
    if raw.is_empty()
        || raw.len() > MAX_MEDIA_DEVICE_ID_BYTES
        || raw.trim() != raw
        || !raw.bytes().all(|b| (0x20..=0x7E).contains(&b))
    {
        return Err(err);
    }
    Ok(raw.to_owned())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn media_capture_defaults_are_safe_and_validation_is_transactional() {
        let mut ctrl = MediaCaptureController::new();
        let initial = ctrl.snapshot();
        assert_eq!(initial.preferred_surface, ScreenShareSurface::Monitor);
        assert!(!initial.system_audio_loopback);
        assert!(initial.noise_suppression);
        assert!(initial.preferred_audio_input_id.is_none());
        assert!(initial.preferred_audio_output_id.is_none());

        let updated = ctrl
            .configure(
                ScreenShareSurface::Window,
                true,
                false,
                Some("usb-condenser-mic-01"),
                Some("studio-headphones-01"),
            )
            .unwrap();
        assert_eq!(updated.preferred_surface, ScreenShareSurface::Window);
        assert!(updated.system_audio_loopback);
        assert!(!updated.noise_suppression);
        assert_eq!(
            updated.preferred_audio_input_id.as_deref(),
            Some("usb-condenser-mic-01")
        );
        assert_eq!(
            updated.preferred_audio_output_id.as_deref(),
            Some("studio-headphones-01")
        );

        // Invalid input/output device IDs leave existing state unchanged.
        for bad_input in [
            "",
            " leading-space",
            "trailing-space ",
            "control\0id",
            "newline\nid",
            "non-ascii-é",
            &"x".repeat(MAX_MEDIA_DEVICE_ID_BYTES + 1),
        ] {
            assert_eq!(
                ctrl.configure(
                    ScreenShareSurface::BrowserTab,
                    false,
                    true,
                    Some(bad_input),
                    None,
                ),
                Err(MediaCaptureError::InvalidAudioInputDeviceId)
            );
            assert_eq!(ctrl.snapshot(), updated);
        }

        assert_eq!(
            ctrl.configure(ScreenShareSurface::BrowserTab, false, true, None, Some("")),
            Err(MediaCaptureError::InvalidAudioOutputDeviceId)
        );
        assert_eq!(ctrl.snapshot(), updated);

        assert_eq!(
            ScreenShareSurface::parse("desktop_all"),
            Err(MediaCaptureError::InvalidScreenShareSurface)
        );

        ctrl.clear();
        assert_eq!(ctrl.snapshot(), initial);
    }
}
