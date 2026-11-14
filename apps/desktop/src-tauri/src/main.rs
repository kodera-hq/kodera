#![forbid(unsafe_code)]
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use std::io;
use std::process::ExitCode;

fn main() -> ExitCode {
    let args: Vec<String> = std::env::args().skip(1).collect();
    let stdin = io::stdin();
    let mut stdout = io::stdout().lock();
    let mut stderr = io::stderr().lock();
    match kodera_desktop::run_cli(&args, stdin.lock(), &mut stdout, &mut stderr) {
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
