//! Native window creation, bounds sanitization, and multi-monitor state restoration.
//!
//! Security & UX invariants:
//! - Window dimensions are clamped to `[MIN_WINDOW_WIDTH..=MAX_WINDOW_DIMENSION]` and
//!   `[MIN_WINDOW_HEIGHT..=MAX_WINDOW_DIMENSION]`, adapting down cleanly when a monitor's work area
//!   is smaller than the nominal minimum (`960x640`).
//! - Coordinates use widened `i64` arithmetic so extreme saved values (`i32::MIN`, `i32::MAX`)
//!   never overflow or panic.
//! - Restored windows require at least [`MIN_VISIBLE_TITLEBAR_PX`] overlap on both axes (including
//!   the top titlebar strip) with an active monitor work area; when an external monitor is
//!   unplugged, the window re-centers cleanly onto the primary monitor instead of opening off-screen.

use core::fmt;
use std::fs;
use std::path::Path;

/// Default initial width matching `tauri.conf.json`.
pub const DEFAULT_WINDOW_WIDTH: u32 = 1280;

/// Default initial height matching `tauri.conf.json`.
pub const DEFAULT_WINDOW_HEIGHT: u32 = 820;

/// Minimum width matching `tauri.conf.json` when the target monitor permits it.
pub const MIN_WINDOW_WIDTH: u32 = 960;

/// Minimum height matching `tauri.conf.json` when the target monitor permits it.
pub const MIN_WINDOW_HEIGHT: u32 = 640;

/// Upper bound on any window or monitor dimension accepted by the host.
pub const MAX_WINDOW_DIMENSION: u32 = 16_384;

/// Minimum visible overlap (in logical pixels) required to keep a window on a secondary monitor.
pub const MIN_VISIBLE_TITLEBAR_PX: i64 = 64;

/// Approximate height of the window drag/titlebar strip that must remain reachable on-screen.
pub const TITLEBAR_REACHABLE_HEIGHT_PX: i64 = 40;

/// Maximum number of connected monitors inspected during placement restoration.
pub const MAX_MONITORS: usize = 16;

/// Maximum UTF-8 byte size accepted when loading persisted window state JSON.
pub const MAX_WINDOW_STATE_JSON_BYTES: usize = 1024;

/// Closed error codes for window bounds validation and persistence.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum WindowStateError {
    InvalidMonitorGeometry,
    TooManyMonitors,
    InvalidCoordinates,
    InvalidDimensions,
    StatePayloadTooLarge,
    InvalidStateJson,
    PersistenceFailed,
}

impl fmt::Display for WindowStateError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        let code = match self {
            Self::InvalidMonitorGeometry => "invalid_monitor_geometry",
            Self::TooManyMonitors => "too_many_monitors",
            Self::InvalidCoordinates => "invalid_coordinates",
            Self::InvalidDimensions => "invalid_dimensions",
            Self::StatePayloadTooLarge => "state_payload_too_large",
            Self::InvalidStateJson => "invalid_state_json",
            Self::PersistenceFailed => "persistence_failed",
        };
        f.write_str(code)
    }
}

impl std::error::Error for WindowStateError {}

/// Usable desktop work area (excluding OS dock/taskbar/menubar) for one connected display.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct MonitorWorkArea {
    pub id: String,
    pub x: i32,
    pub y: i32,
    pub width: u32,
    pub height: u32,
    /// Scale factor in thousandths (`1000` = 1.0x, `2000` = 2.0x Retina/HiDPI).
    pub scale_factor_milli: u32,
    pub is_primary: bool,
}

impl MonitorWorkArea {
    pub fn fallback_primary() -> Self {
        Self {
            id: "primary-fallback".to_owned(),
            x: 0,
            y: 0,
            width: 1920,
            height: 1080,
            scale_factor_milli: 1000,
            is_primary: true,
        }
    }

    pub fn validate(&self) -> Result<(), WindowStateError> {
        if self.id.is_empty()
            || self.id.len() > 64
            || !self.id.is_ascii()
            || self.id.bytes().any(|b| b.is_ascii_control())
        {
            return Err(WindowStateError::InvalidMonitorGeometry);
        }
        if self.width < 320
            || self.height < 240
            || self.width > MAX_WINDOW_DIMENSION
            || self.height > MAX_WINDOW_DIMENSION
        {
            return Err(WindowStateError::InvalidMonitorGeometry);
        }
        if !(500..=8000).contains(&self.scale_factor_milli) {
            return Err(WindowStateError::InvalidMonitorGeometry);
        }
        let right = i64::from(self.x) + i64::from(self.width);
        let bottom = i64::from(self.y) + i64::from(self.height);
        if right > i64::from(i32::MAX) || bottom > i64::from(i32::MAX) {
            return Err(WindowStateError::InvalidMonitorGeometry);
        }
        Ok(())
    }
}

/// Logical window rectangle in desktop screen coordinates.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct WindowBounds {
    pub x: i32,
    pub y: i32,
    pub width: u32,
    pub height: u32,
}

/// Persisted window geometry and presentation flags.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct SavedWindowState {
    pub bounds: WindowBounds,
    pub maximized: bool,
    pub fullscreen: bool,
    pub visible: bool,
}

impl Default for SavedWindowState {
    fn default() -> Self {
        Self {
            bounds: WindowBounds {
                x: 0,
                y: 0,
                width: DEFAULT_WINDOW_WIDTH,
                height: DEFAULT_WINDOW_HEIGHT,
            },
            maximized: false,
            fullscreen: false,
            visible: true,
        }
    }
}

impl SavedWindowState {
    pub fn to_json(&self) -> String {
        format!(
            r#"{{"x":{},"y":{},"width":{},"height":{},"maximized":{},"fullscreen":{},"visible":{}}}"#,
            self.bounds.x,
            self.bounds.y,
            self.bounds.width,
            self.bounds.height,
            self.maximized,
            self.fullscreen,
            self.visible,
        )
    }

    pub fn from_json(raw: &str) -> Result<Self, WindowStateError> {
        if raw.len() > MAX_WINDOW_STATE_JSON_BYTES {
            return Err(WindowStateError::StatePayloadTooLarge);
        }
        let trimmed = raw.trim();
        let Some(inner) = trimmed.strip_prefix('{').and_then(|s| s.strip_suffix('}')) else {
            return Err(WindowStateError::InvalidStateJson);
        };
        if inner.trim().is_empty() {
            return Err(WindowStateError::InvalidStateJson);
        }

        let mut x: Option<i32> = None;
        let mut y: Option<i32> = None;
        let mut width: Option<u32> = None;
        let mut height: Option<u32> = None;
        let mut maximized: Option<bool> = None;
        let mut fullscreen: Option<bool> = None;
        let mut visible: Option<bool> = None;

        for entry in inner.split(',') {
            let Some((raw_key, raw_val)) = entry.split_once(':') else {
                return Err(WindowStateError::InvalidStateJson);
            };
            let key = raw_key
                .trim()
                .strip_prefix('"')
                .and_then(|s| s.strip_suffix('"'))
                .ok_or(WindowStateError::InvalidStateJson)?;
            let val = raw_val.trim();
            match key {
                "x" if x.is_none() => {
                    x = Some(
                        parse_signed_i32(val).map_err(|_| WindowStateError::InvalidStateJson)?,
                    );
                }
                "y" if y.is_none() => {
                    y = Some(
                        parse_signed_i32(val).map_err(|_| WindowStateError::InvalidStateJson)?,
                    );
                }
                "width" if width.is_none() => {
                    width = Some(
                        val.parse::<u32>()
                            .map_err(|_| WindowStateError::InvalidStateJson)?,
                    );
                }
                "height" if height.is_none() => {
                    height = Some(
                        val.parse::<u32>()
                            .map_err(|_| WindowStateError::InvalidStateJson)?,
                    );
                }
                "maximized" if maximized.is_none() => {
                    maximized = Some(parse_bool_literal(val)?);
                }
                "fullscreen" if fullscreen.is_none() => {
                    fullscreen = Some(parse_bool_literal(val)?);
                }
                "visible" if visible.is_none() => {
                    visible = Some(parse_bool_literal(val)?);
                }
                _ => return Err(WindowStateError::InvalidStateJson),
            }
        }

        Ok(Self {
            bounds: WindowBounds {
                x: x.ok_or(WindowStateError::InvalidStateJson)?,
                y: y.ok_or(WindowStateError::InvalidStateJson)?,
                width: width.ok_or(WindowStateError::InvalidStateJson)?,
                height: height.ok_or(WindowStateError::InvalidStateJson)?,
            },
            maximized: maximized.ok_or(WindowStateError::InvalidStateJson)?,
            fullscreen: fullscreen.ok_or(WindowStateError::InvalidStateJson)?,
            visible: visible.ok_or(WindowStateError::InvalidStateJson)?,
        })
    }
}

/// Sanitized window placement bound to a verified display work area.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RestoredWindowPlacement {
    pub bounds: WindowBounds,
    pub maximized: bool,
    pub fullscreen: bool,
    pub visible: bool,
    pub target_monitor_id: String,
    pub clamped: bool,
}

/// Parses a canonical decimal `i32` string without leading-zero ambiguity (`"-1920"`, `"0"`, `"120"`).
pub fn parse_signed_i32(raw: &str) -> Result<i32, WindowStateError> {
    if raw.is_empty() || raw.len() > 12 {
        return Err(WindowStateError::InvalidCoordinates);
    }
    if raw == "0" {
        return Ok(0);
    }
    let digits = raw.strip_prefix('-').unwrap_or(raw);
    if digits.is_empty() || digits.starts_with('0') || !digits.bytes().all(|b| b.is_ascii_digit()) {
        return Err(WindowStateError::InvalidCoordinates);
    }
    raw.parse::<i32>()
        .map_err(|_| WindowStateError::InvalidCoordinates)
}

fn parse_bool_literal(raw: &str) -> Result<bool, WindowStateError> {
    match raw {
        "true" => Ok(true),
        "false" => Ok(false),
        _ => Err(WindowStateError::InvalidStateJson),
    }
}

/// Sanitizes and clamps saved window bounds across a multi-monitor desktop layout.
pub fn sanitize_and_clamp_window_state(
    saved: Option<&SavedWindowState>,
    monitors: &[MonitorWorkArea],
) -> Result<RestoredWindowPlacement, WindowStateError> {
    if monitors.len() > MAX_MONITORS {
        return Err(WindowStateError::TooManyMonitors);
    }
    for monitor in monitors {
        monitor.validate()?;
    }

    let fallback = [MonitorWorkArea::fallback_primary()];
    let active_monitors = if monitors.is_empty() {
        &fallback[..]
    } else {
        monitors
    };

    let primary_monitor = active_monitors
        .iter()
        .find(|m| m.is_primary)
        .unwrap_or(&active_monitors[0]);

    let Some(saved_state) = saved else {
        let centered =
            center_on_monitor(DEFAULT_WINDOW_WIDTH, DEFAULT_WINDOW_HEIGHT, primary_monitor);
        return Ok(RestoredWindowPlacement {
            bounds: centered,
            maximized: false,
            fullscreen: false,
            visible: true,
            target_monitor_id: primary_monitor.id.clone(),
            clamped: monitors.is_empty(),
        });
    };

    if saved_state.bounds.width == 0 || saved_state.bounds.height == 0 {
        let centered =
            center_on_monitor(DEFAULT_WINDOW_WIDTH, DEFAULT_WINDOW_HEIGHT, primary_monitor);
        return Ok(RestoredWindowPlacement {
            bounds: centered,
            maximized: saved_state.maximized,
            fullscreen: !saved_state.maximized && saved_state.fullscreen,
            visible: saved_state.visible,
            target_monitor_id: primary_monitor.id.clone(),
            clamped: true,
        });
    }

    let best_match = select_target_monitor(&saved_state.bounds, active_monitors);
    let (target_monitor, had_reachable_overlap) = match best_match {
        Some(mon) => (mon, true),
        None => (primary_monitor, false),
    };

    let min_w = MIN_WINDOW_WIDTH.min(target_monitor.width);
    let max_w = target_monitor.width.min(MAX_WINDOW_DIMENSION);
    let clamped_width = saved_state.bounds.width.clamp(min_w, max_w);

    let min_h = MIN_WINDOW_HEIGHT.min(target_monitor.height);
    let max_h = target_monitor.height.min(MAX_WINDOW_DIMENSION);
    let clamped_height = saved_state.bounds.height.clamp(min_h, max_h);

    let bounds = if !had_reachable_overlap {
        center_on_monitor(clamped_width, clamped_height, target_monitor)
    } else {
        let mon_left = i64::from(target_monitor.x);
        let mon_top = i64::from(target_monitor.y);
        let max_x = mon_left + i64::from(target_monitor.width) - i64::from(clamped_width);
        let max_y = mon_top + i64::from(target_monitor.height) - i64::from(clamped_height);
        let clamped_x = i64::from(saved_state.bounds.x).clamp(mon_left, max_x) as i32;
        let clamped_y = i64::from(saved_state.bounds.y).clamp(mon_top, max_y) as i32;
        WindowBounds {
            x: clamped_x,
            y: clamped_y,
            width: clamped_width,
            height: clamped_height,
        }
    };

    // Maximized and fullscreen are mutually exclusive; fullscreen wins only when maximized is false.
    let maximized = saved_state.maximized;
    let fullscreen = !maximized && saved_state.fullscreen;
    let clamped = !had_reachable_overlap
        || bounds != saved_state.bounds
        || fullscreen != saved_state.fullscreen
        || monitors.is_empty();

    Ok(RestoredWindowPlacement {
        bounds,
        maximized,
        fullscreen,
        visible: saved_state.visible,
        target_monitor_id: target_monitor.id.clone(),
        clamped,
    })
}

fn center_on_monitor(
    desired_width: u32,
    desired_height: u32,
    monitor: &MonitorWorkArea,
) -> WindowBounds {
    let min_w = MIN_WINDOW_WIDTH.min(monitor.width);
    let width = desired_width.clamp(min_w, monitor.width.min(MAX_WINDOW_DIMENSION));
    let min_h = MIN_WINDOW_HEIGHT.min(monitor.height);
    let height = desired_height.clamp(min_h, monitor.height.min(MAX_WINDOW_DIMENSION));
    let x = i64::from(monitor.x) + (i64::from(monitor.width) - i64::from(width)) / 2;
    let y = i64::from(monitor.y) + (i64::from(monitor.height) - i64::from(height)) / 2;
    WindowBounds {
        x: x as i32,
        y: y as i32,
        width,
        height,
    }
}

fn select_target_monitor<'a>(
    bounds: &WindowBounds,
    monitors: &'a [MonitorWorkArea],
) -> Option<&'a MonitorWorkArea> {
    let win_left = i64::from(bounds.x);
    let win_top = i64::from(bounds.y);
    let win_right = win_left + i64::from(bounds.width.min(MAX_WINDOW_DIMENSION));
    let win_bottom = win_top + i64::from(bounds.height.min(MAX_WINDOW_DIMENSION));
    let titlebar_bottom = win_top
        .saturating_add(TITLEBAR_REACHABLE_HEIGHT_PX)
        .min(win_bottom);

    let mut best: Option<(&MonitorWorkArea, i64)> = None;
    for monitor in monitors {
        let mon_left = i64::from(monitor.x);
        let mon_top = i64::from(monitor.y);
        let mon_right = mon_left + i64::from(monitor.width);
        let mon_bottom = mon_top + i64::from(monitor.height);

        let overlap_w = win_right.min(mon_right) - win_left.max(mon_left);
        let overlap_h = win_bottom.min(mon_bottom) - win_top.max(mon_top);
        let titlebar_overlap_h = titlebar_bottom.min(mon_bottom) - win_top.max(mon_top);

        let min_req_w = MIN_VISIBLE_TITLEBAR_PX.min(i64::from(monitor.width));
        let min_req_h = MIN_VISIBLE_TITLEBAR_PX.min(i64::from(monitor.height));

        if overlap_w >= min_req_w && overlap_h >= min_req_h && titlebar_overlap_h > 0 {
            let area = overlap_w.saturating_mul(overlap_h);
            match best {
                Some((_, best_area)) if area <= best_area => {}
                _ => best = Some((monitor, area)),
            }
        }
    }
    best.map(|(mon, _)| mon)
}

/// Atomically writes `SavedWindowState` to disk via a sibling `.tmp` file rename.
pub fn save_window_state_atomic(
    path: &Path,
    state: &SavedWindowState,
) -> Result<(), WindowStateError> {
    let Some(parent) = path.parent() else {
        return Err(WindowStateError::PersistenceFailed);
    };
    fs::create_dir_all(parent).map_err(|_| WindowStateError::PersistenceFailed)?;
    let tmp_path = path.with_extension("json.tmp");
    let serialized = state.to_json();
    fs::write(&tmp_path, serialized.as_bytes()).map_err(|_| WindowStateError::PersistenceFailed)?;
    fs::rename(&tmp_path, path).map_err(|_| {
        let _ = fs::remove_file(&tmp_path);
        WindowStateError::PersistenceFailed
    })
}

/// Loads `SavedWindowState` from disk, returning `Ok(None)` if no prior state file exists.
pub fn load_window_state(path: &Path) -> Result<Option<SavedWindowState>, WindowStateError> {
    if !path.exists() {
        return Ok(None);
    }
    let metadata = fs::symlink_metadata(path).map_err(|_| WindowStateError::PersistenceFailed)?;
    if !metadata.file_type().is_file() {
        return Err(WindowStateError::PersistenceFailed);
    }
    if metadata.len() > MAX_WINDOW_STATE_JSON_BYTES as u64 {
        return Err(WindowStateError::StatePayloadTooLarge);
    }
    let text = fs::read_to_string(path).map_err(|_| WindowStateError::InvalidStateJson)?;
    SavedWindowState::from_json(&text).map(Some)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn dual_monitor_layout() -> Vec<MonitorWorkArea> {
        vec![
            MonitorWorkArea {
                id: "builtin-retina".to_owned(),
                x: 0,
                y: 0,
                width: 1512,
                height: 945,
                scale_factor_milli: 2000,
                is_primary: true,
            },
            MonitorWorkArea {
                id: "external-left-4k".to_owned(),
                x: -2560,
                y: -120,
                width: 2560,
                height: 1440,
                scale_factor_milli: 2000,
                is_primary: false,
            },
        ]
    }

    #[test]
    fn centers_default_window_when_no_prior_state_exists() {
        let monitors = dual_monitor_layout();
        let placement = sanitize_and_clamp_window_state(None, &monitors).unwrap();
        assert_eq!(placement.target_monitor_id, "builtin-retina");
        assert!(!placement.clamped);
        assert_eq!(placement.bounds.width, 1280);
        assert_eq!(placement.bounds.height, 820);
        assert_eq!(placement.bounds.x, (1512 - 1280) / 2);
        assert_eq!(placement.bounds.y, (945 - 820) / 2);
        assert!(placement.visible);
    }

    #[test]
    fn preserves_valid_negative_coordinate_window_on_secondary_monitor() {
        let monitors = dual_monitor_layout();
        let saved = SavedWindowState {
            bounds: WindowBounds {
                x: -2200,
                y: 40,
                width: 1400,
                height: 900,
            },
            maximized: false,
            fullscreen: false,
            visible: true,
        };
        let restored = sanitize_and_clamp_window_state(Some(&saved), &monitors).unwrap();
        assert_eq!(restored.target_monitor_id, "external-left-4k");
        assert!(!restored.clamped);
        assert_eq!(restored.bounds, saved.bounds);
    }

    #[test]
    fn recenters_onto_primary_when_secondary_monitor_is_unplugged() {
        let primary_only = vec![dual_monitor_layout().remove(0)];
        let stranded_on_unplugged = SavedWindowState {
            bounds: WindowBounds {
                x: -2400,
                y: 50,
                width: 1400,
                height: 900,
            },
            maximized: false,
            fullscreen: false,
            visible: true,
        };
        let restored =
            sanitize_and_clamp_window_state(Some(&stranded_on_unplugged), &primary_only).unwrap();
        assert_eq!(restored.target_monitor_id, "builtin-retina");
        assert!(restored.clamped);
        assert!(restored.bounds.x >= 0);
        assert!(restored.bounds.y >= 0);
        assert!(restored.bounds.x + (restored.bounds.width as i32) <= 1512);
        assert!(restored.bounds.y + (restored.bounds.height as i32) <= 945);
    }

    #[test]
    fn clamps_extreme_coordinates_and_dimensions_without_overflow() {
        let monitors = dual_monitor_layout();
        for extreme in [
            SavedWindowState {
                bounds: WindowBounds {
                    x: i32::MIN,
                    y: i32::MAX,
                    width: u32::MAX,
                    height: u32::MAX,
                },
                maximized: true,
                fullscreen: true,
                visible: true,
            },
            SavedWindowState {
                bounds: WindowBounds {
                    x: 100,
                    y: 100,
                    width: 12,
                    height: 8,
                },
                maximized: false,
                fullscreen: false,
                visible: false,
            },
            SavedWindowState {
                bounds: WindowBounds {
                    x: 0,
                    y: 0,
                    width: 0,
                    height: 0,
                },
                maximized: false,
                fullscreen: false,
                visible: true,
            },
        ] {
            let restored = sanitize_and_clamp_window_state(Some(&extreme), &monitors).unwrap();
            assert!(restored.clamped);
            assert!(restored.bounds.width >= MIN_WINDOW_WIDTH);
            assert!(restored.bounds.width <= 1512);
            assert!(restored.bounds.height >= MIN_WINDOW_HEIGHT);
            assert!(restored.bounds.height <= 945);
            if restored.maximized {
                assert!(!restored.fullscreen);
            }
        }
    }

    #[test]
    fn adapts_to_compact_display_smaller_than_nominal_minimum() {
        let compact = [MonitorWorkArea {
            id: "compact-panel".to_owned(),
            x: 0,
            y: 0,
            width: 800,
            height: 600,
            scale_factor_milli: 1000,
            is_primary: true,
        }];
        let restored = sanitize_and_clamp_window_state(None, &compact).unwrap();
        assert_eq!(restored.bounds.width, 800);
        assert_eq!(restored.bounds.height, 600);
        assert_eq!(restored.bounds.x, 0);
        assert_eq!(restored.bounds.y, 0);
    }

    #[test]
    fn persists_and_reloads_json_while_rejecting_corrupt_payloads() {
        let state = SavedWindowState {
            bounds: WindowBounds {
                x: -1280,
                y: 64,
                width: 1320,
                height: 840,
            },
            maximized: false,
            fullscreen: false,
            visible: true,
        };
        let encoded = state.to_json();
        assert_eq!(SavedWindowState::from_json(&encoded).unwrap(), state);

        for invalid in [
            "",
            "{}",
            r#"{"x":0,"y":0,"width":1280,"height":820,"maximized":false,"fullscreen":false}"#,
            r#"{"x":0,"x":1,"y":0,"width":1280,"height":820,"maximized":false,"fullscreen":false,"visible":true}"#,
            r#"{"x":-01,"y":0,"width":1280,"height":820,"maximized":false,"fullscreen":false,"visible":true}"#,
            r#"{"x":0,"y":0,"width":1280,"height":820,"maximized":"no","fullscreen":false,"visible":true}"#,
        ] {
            assert!(SavedWindowState::from_json(invalid).is_err());
        }

        let dir = std::env::temp_dir().join(format!("kodera-win-state-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        let file_path = dir.join("window-state.json");
        assert_eq!(load_window_state(&file_path).unwrap(), None);
        save_window_state_atomic(&file_path, &state).unwrap();
        assert_eq!(load_window_state(&file_path).unwrap(), Some(state));
        let _ = fs::remove_dir_all(&dir);
    }
}
