//! Native tao/wry desktop window and event-loop host.

use super::*;
use crate::{
    load_window_state, sanitize_and_clamp_window_state, save_window_state_atomic,
    verify_embedded_tauri_conf_csp, DesktopShellError, MonitorWorkArea, SavedWindowState,
    WindowBounds,
};
use crate::{DeepLinkAdmissionPolicy, DesktopShellHost, MAX_IPC_COMMAND_BYTES};
use std::borrow::Cow;
use tao::{
    dpi::{LogicalPosition, LogicalSize},
    event::{Event, WindowEvent},
    event_loop::{ControlFlow, EventLoopBuilder},
    window::WindowBuilder,
};
use wry::{
    http::{header::CONTENT_TYPE, Response},
    NewWindowResponse, PageLoadEvent, WebViewBuilder,
};

#[derive(Debug)]
enum DesktopUserEvent {
    IpcMessage {
        generation: u64,
        sender_url: String,
        body: String,
    },
    DocumentChanged(u64),
    UpdateReady(crate::updater::ReadyUpdate),
    InterceptedDeepLink {
        generation: u64,
        admitted: AdmittedDeepLink,
    },
}

fn default_window_state_path() -> Option<PathBuf> {
    #[cfg(target_os = "macos")]
    {
        let home = std::env::var_os("HOME")?;
        Some(
            PathBuf::from(home)
                .join("Library")
                .join("Application Support")
                .join(DESKTOP_APP_IDENTIFIER)
                .join("window-state.json"),
        )
    }
    #[cfg(target_os = "windows")]
    {
        let appdata = std::env::var_os("APPDATA")?;
        Some(
            PathBuf::from(appdata)
                .join(DESKTOP_APP_IDENTIFIER)
                .join("window-state.json"),
        )
    }
    #[cfg(not(any(target_os = "macos", target_os = "windows")))]
    {
        if let Some(xdg) = std::env::var_os("XDG_CONFIG_HOME") {
            if !xdg.is_empty() {
                return Some(
                    PathBuf::from(xdg)
                        .join(DESKTOP_APP_IDENTIFIER)
                        .join("window-state.json"),
                );
            }
        }
        let home = std::env::var_os("HOME")?;
        Some(
            PathBuf::from(home)
                .join(".config")
                .join(DESKTOP_APP_IDENTIFIER)
                .join("window-state.json"),
        )
    }
}

fn collect_monitors<T>(event_loop: &tao::event_loop::EventLoop<T>) -> Vec<MonitorWorkArea> {
    let primary_name = event_loop.primary_monitor().and_then(|m| m.name());
    let mut out = Vec::new();
    for (idx, handle) in event_loop.available_monitors().take(16).enumerate() {
        let scale = handle.scale_factor();
        let scale_milli = if scale.is_finite() && (0.5..=8.0).contains(&scale) {
            #[allow(clippy::cast_possible_truncation, clippy::cast_sign_loss)]
            let v = (scale * 1000.0).round() as u32;
            v.clamp(500, 8000)
        } else {
            1000
        };
        let pos = handle.position().to_logical::<i32>(scale);
        let size = handle.size().to_logical::<u32>(scale);
        let is_primary = match (&primary_name, handle.name()) {
            (Some(p), Some(n)) => *p == n,
            _ => idx == 0,
        };
        let raw_id = handle.name().unwrap_or_else(|| format!("display-{idx}"));
        let ascii_id: String = raw_id
            .chars()
            .filter(|c| c.is_ascii() && !c.is_ascii_control())
            .take(48)
            .collect();
        let area = MonitorWorkArea {
            id: if ascii_id.is_empty() {
                format!("display-{idx}")
            } else {
                ascii_id
            },
            x: pos.x,
            y: pos.y,
            width: size.width,
            height: size.height,
            scale_factor_milli: scale_milli,
            is_primary,
        };
        if area.validate().is_ok() {
            out.push(area);
        }
    }
    if out.is_empty() {
        out.push(MonitorWorkArea::fallback_primary());
    }
    out
}

pub(super) fn configure_gui_window_builder(
    placement: &RestoredWindowPlacement,
    monitors: &[MonitorWorkArea],
) -> WindowBuilder {
    let (min_width, min_height) = super::effective_gui_min_inner_size(placement, monitors);
    const WINDOW_ICON: &[u8; 256 * 256 * 4] = include_bytes!("../../icons/window-icon.rgba");
    WindowBuilder::new()
        .with_window_icon(Some(
            tao::window::Icon::from_rgba(WINDOW_ICON.to_vec(), 256, 256)
                .expect("official window icon has verified RGBA dimensions"),
        ))
        .with_title(DESKTOP_WINDOW_TITLE)
        .with_inner_size(LogicalSize::new(
            f64::from(placement.bounds.width),
            f64::from(placement.bounds.height),
        ))
        .with_min_inner_size(LogicalSize::new(
            f64::from(min_width),
            f64::from(min_height),
        ))
        .with_position(LogicalPosition::new(
            f64::from(placement.bounds.x),
            f64::from(placement.bounds.y),
        ))
        .with_maximized(placement.maximized)
        .with_resizable(true)
        .with_visible(true)
}

/// Launches the native OS desktop window, WebView custom protocol + IPC handler, and event loop.
pub fn launch_desktop_gui(options: DesktopGuiOptions) -> Result<(), DesktopShellError> {
    let _ = DesktopShellHost::self_check()?;
    let embedded_csp = verify_embedded_tauri_conf_csp()
        .map_err(|_| DesktopShellError::SelfCheckFailed("csp_policy"))?;
    verify_embedded_default_capability()
        .map_err(|_| DesktopShellError::SelfCheckFailed("capability_policy"))?;

    let policy = DeepLinkAdmissionPolicy::kodera_default();
    let startup_url = if let Some(ref custom_url) = options.override_url {
        match validate_navigation_url(custom_url, &policy, options.allow_dev_origin) {
            Ok(
                NavigationDecision::AllowInternalAsset { .. }
                | NavigationDecision::AllowTrustedWebOrigin { .. },
            ) => custom_url.clone(),
            _ => return Err(DesktopShellError::UntrustedStartupUrl),
        }
    } else {
        format!("{INTERNAL_ASSET_ORIGIN}/index.html")
    };

    let event_loop = EventLoopBuilder::<DesktopUserEvent>::with_user_event().build();
    let monitors = collect_monitors(&event_loop);
    let state_path = default_window_state_path();
    let saved_on_disk = state_path
        .as_deref()
        .and_then(|p| load_window_state(p).ok().flatten());
    let placement = sanitize_and_clamp_window_state(saved_on_disk.as_ref(), &monitors)
        .unwrap_or_else(|_| {
            sanitize_and_clamp_window_state(None, &[MonitorWorkArea::fallback_primary()])
                .expect("fallback primary monitor geometry is valid")
        });

    let window = configure_gui_window_builder(&placement, &monitors)
        .build(&event_loop)
        .map_err(|_| DesktopShellError::GuiWindowInitFailed)?;

    let document_generation = std::sync::Arc::new(std::sync::atomic::AtomicU64::new(0));
    let ipc_generation = document_generation.clone();
    let nav_generation = document_generation.clone();
    let popup_generation = document_generation.clone();
    let page_generation = document_generation.clone();
    let page_proxy = event_loop.create_proxy();
    let ipc_proxy = event_loop.create_proxy();
    let nav_proxy = event_loop.create_proxy();
    let popup_proxy = event_loop.create_proxy();
    let nav_policy = policy.clone();
    let popup_policy = policy;
    let allow_dev = options.allow_dev_origin;
    let asset_root = options.asset_root.clone();
    let csp_for_protocol = embedded_csp;

    let builder = WebViewBuilder::new()
        .with_custom_protocol(
            CUSTOM_ASSET_SCHEME.to_owned(),
            move |_webview_id, request| {
                let payload = resolve_asset_response(
                    asset_root.as_deref(),
                    request.uri().path(),
                    &csp_for_protocol,
                );
                Response::builder()
                    .status(payload.status)
                    .header(CONTENT_TYPE, payload.content_type)
                    .header("Content-Security-Policy", payload.csp_header)
                    .header("X-Content-Type-Options", "nosniff")
                    .header("X-Frame-Options", "DENY")
                    .header("Cache-Control", "no-store")
                    .body(Cow::Owned(payload.body))
                    .unwrap_or_else(|_| {
                        Response::builder()
                            .status(500)
                            .body(Cow::Borrowed(&b"internal_asset_error"[..]))
                            .expect("static fallback HTTP response is valid")
                    })
            },
        )
        .with_on_page_load_handler(move |event, _url| {
            if matches!(event, PageLoadEvent::Started) {
                let generation =
                    page_generation.fetch_add(1, std::sync::atomic::Ordering::SeqCst) + 1;
                let _ = page_proxy.send_event(DesktopUserEvent::DocumentChanged(generation));
            }
        })
        .with_initialization_script_for_main_only(build_ipc_init_script(), true)
        .with_initialization_script_for_main_only(
            format!(
                "(function(messages){{ {} }})({});",
                include_str!("../../assets/updater.js"),
                include_str!("../../assets/updater-messages.json")
            ),
            true,
        )
        .with_ipc_handler(move |request| {
            let body = request.body();
            if body.len() <= MAX_IPC_COMMAND_BYTES {
                let _ = ipc_proxy.send_event(DesktopUserEvent::IpcMessage {
                    generation: ipc_generation.load(std::sync::atomic::Ordering::SeqCst),
                    sender_url: request.uri().to_string(),
                    body: body.clone(),
                });
            }
        })
        .with_navigation_handler(move |target_url| {
            match validate_navigation_url(&target_url, &nav_policy, allow_dev) {
                Ok(
                    NavigationDecision::AllowInternalAsset { .. }
                    | NavigationDecision::AllowTrustedWebOrigin { .. },
                ) => true,
                Ok(NavigationDecision::InterceptDeepLink(admitted)) => {
                    let _ = nav_proxy.send_event(DesktopUserEvent::InterceptedDeepLink {
                        generation: nav_generation.load(std::sync::atomic::Ordering::SeqCst),
                        admitted,
                    });
                    false
                }
                Err(_) => false,
            }
        })
        .with_new_window_req_handler(move |target_url, _features| {
            if let Ok(NavigationDecision::InterceptDeepLink(admitted)) =
                validate_navigation_url(&target_url, &popup_policy, allow_dev)
            {
                let _ = popup_proxy.send_event(DesktopUserEvent::InterceptedDeepLink {
                    generation: popup_generation.load(std::sync::atomic::Ordering::SeqCst),
                    admitted,
                });
            }
            NewWindowResponse::Deny
        })
        .with_clipboard(true)
        .with_hotkeys_zoom(false)
        .with_url(startup_url);

    #[cfg(target_os = "windows")]
    let builder = {
        use wry::WebViewBuilderExtWindows;
        builder.with_https_scheme(true)
    };

    #[cfg(any(
        target_os = "windows",
        target_os = "macos",
        target_os = "ios",
        target_os = "android"
    ))]
    let webview = builder
        .build(&window)
        .map_err(|_| DesktopShellError::GuiWebViewInitFailed)?;

    #[cfg(not(any(
        target_os = "windows",
        target_os = "macos",
        target_os = "ios",
        target_os = "android"
    )))]
    let webview = {
        use tao::platform::unix::WindowExtUnix;
        use wry::WebViewBuilderExtUnix;
        let vbox = window
            .default_vbox()
            .ok_or(DesktopShellError::GuiWebViewInitFailed)?;
        builder
            .build_gtk(vbox)
            .map_err(|_| DesktopShellError::GuiWebViewInitFailed)?
    };

    let update_proxy = event_loop.create_proxy();
    std::thread::spawn(move || {
        if let Ok(update) = crate::updater::check() {
            let _ = update_proxy.send_event(DesktopUserEvent::UpdateReady(update));
        }
    });
    let mut bridge = DesktopWebViewBridge::new(options.allow_dev_origin, options.initial_deep_link);
    let mut live_state = SavedWindowState {
        bounds: WindowBounds {
            x: placement.bounds.x,
            y: placement.bounds.y,
            width: placement.bounds.width,
            height: placement.bounds.height,
        },
        maximized: placement.maximized,
        fullscreen: placement.fullscreen,
        visible: true,
    };

    event_loop.run(move |event, _, control_flow| {
        *control_flow = ControlFlow::Wait;

        match event {
            Event::WindowEvent {
                event: WindowEvent::Moved(pos),
                ..
            } => {
                let logical = pos.to_logical::<i32>(window.scale_factor());
                live_state.bounds.x = logical.x;
                live_state.bounds.y = logical.y;
            }
            Event::WindowEvent {
                event: WindowEvent::Resized(size),
                ..
            } => {
                let logical = size.to_logical::<u32>(window.scale_factor());
                if logical.width >= 320 && logical.height >= 240 {
                    live_state.bounds.width = logical.width;
                    live_state.bounds.height = logical.height;
                }
                live_state.maximized = window.is_maximized();
            }
            Event::WindowEvent {
                event: WindowEvent::CloseRequested,
                ..
            } => {
                if let Some(ref path) = state_path {
                    let _ = save_window_state_atomic(path, &live_state);
                }
                bridge.clear_session();
                *control_flow = ControlFlow::Exit;
            }
            Event::UserEvent(DesktopUserEvent::InterceptedDeepLink {
                generation,
                admitted,
            }) => {
                if generation != document_generation.load(std::sync::atomic::Ordering::SeqCst) {
                    return;
                }
                bridge.begin_document(generation);
                window.set_visible(true);
                window.set_minimized(false);
                window.set_focus();
                for js in bridge.enqueue_deep_link(admitted) {
                    let _ = webview.evaluate_script(&js);
                }
            }
            Event::UserEvent(DesktopUserEvent::UpdateReady(update)) => {
                bridge.ready_update = Some(update);
            }
            Event::UserEvent(DesktopUserEvent::DocumentChanged(generation)) => {
                if generation == document_generation.load(std::sync::atomic::Ordering::SeqCst) {
                    bridge.begin_document(generation);
                }
            }
            Event::UserEvent(DesktopUserEvent::IpcMessage {
                generation,
                sender_url,
                body,
            }) => {
                if generation != document_generation.load(std::sync::atomic::Ordering::SeqCst) {
                    return;
                }
                bridge.begin_document(generation);
                if let Ok(outcome) = bridge.handle_ipc_request(&sender_url, &body) {
                    if generation != document_generation.load(std::sync::atomic::Ordering::SeqCst) {
                        return;
                    }
                    for js in outcome.eval_scripts {
                        let _ = webview.evaluate_script(&js);
                    }
                    if let Some(action) = outcome.window_action {
                        match action {
                            GuiWindowAction::ShowAndFocus => {
                                window.set_visible(true);
                                window.set_minimized(false);
                                window.set_focus();
                                live_state.visible = true;
                            }
                            GuiWindowAction::Hide => {
                                window.set_visible(false);
                                live_state.visible = false;
                            }
                            GuiWindowAction::SetTitle(title) => {
                                window.set_title(&title);
                            }
                            GuiWindowAction::ApplyPlacement(p) => {
                                window.set_outer_position(LogicalPosition::new(
                                    f64::from(p.bounds.x),
                                    f64::from(p.bounds.y),
                                ));
                                window.set_inner_size(LogicalSize::new(
                                    f64::from(p.bounds.width),
                                    f64::from(p.bounds.height),
                                ));
                                live_state.bounds = p.bounds;
                            }
                            GuiWindowAction::Quit => {
                                if let Some(ref path) = state_path {
                                    let _ = save_window_state_atomic(path, &live_state);
                                }
                                bridge.clear_session();
                                *control_flow = ControlFlow::Exit;
                            }
                        }
                    }
                }
            }
            Event::LoopDestroyed => {
                bridge.clear_session();
            }
            _ => {}
        }
    });
}
