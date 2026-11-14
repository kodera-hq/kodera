#![forbid(unsafe_code)]
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use kodera_desktop::{
    classify_launch_args, launch_desktop_gui, run_cli, DesktopGuiOptions, DesktopLaunchMode,
    DesktopShellError,
};
use std::io;
use std::process::ExitCode;

fn main() -> ExitCode {
    let args: Vec<String> = std::env::args().skip(1).collect();
    match classify_launch_args(&args) {
        Ok(DesktopLaunchMode::Gui { initial_deep_link }) => {
            let options = DesktopGuiOptions::from_environment(initial_deep_link);
            match launch_desktop_gui(options) {
                Ok(()) => ExitCode::SUCCESS,
                Err(err) => {
                    let mut stderr = io::stderr().lock();
                    let _ = io::Write::write_fmt(
                        &mut stderr,
                        format_args!("{{\"ok\":false,\"error\":\"{err}\"}}\n"),
                    );
                    ExitCode::from(1)
                }
            }
        }
        Ok(DesktopLaunchMode::Cli(cli_args)) => {
            let stdin = io::stdin();
            let mut stdout = io::stdout().lock();
            let mut stderr = io::stderr().lock();
            match run_cli(&cli_args, stdin.lock(), &mut stdout, &mut stderr) {
                Ok(code) => ExitCode::from(u8::try_from(code).unwrap_or(1)),
                Err(err) => {
                    let _ = io::Write::write_fmt(
                        &mut stderr,
                        format_args!("{{\"ok\":false,\"error\":\"{err}\"}}\n"),
                    );
                    ExitCode::from(1)
                }
            }
        }
        Err(DesktopShellError::DeepLinkRejected(code)) => {
            let mut stderr = io::stderr().lock();
            let _ = io::Write::write_fmt(
                &mut stderr,
                format_args!("{{\"ok\":false,\"error\":\"deep_link:{code}\"}}\n"),
            );
            ExitCode::from(2)
        }
        Err(err) => {
            let mut stderr = io::stderr().lock();
            let _ = io::Write::write_fmt(
                &mut stderr,
                format_args!("{{\"ok\":false,\"error\":\"{err}\"}}\n"),
            );
            ExitCode::from(1)
        }
    }
}
