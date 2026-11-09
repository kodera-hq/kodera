#![forbid(unsafe_code)]
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    // Entry point for native desktop bundle (`cargo run --features desktop-app`).
    let _ = kodera_desktop::DESKTOP_APP_IDENTIFIER;
}
