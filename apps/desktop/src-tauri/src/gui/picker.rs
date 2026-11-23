//! Native OS folder-picker seam for operator authorization of a local Community stack directory.

use std::path::PathBuf;

/// Native OS directory chooser seam used to grant explicit user consent for a local Community
/// stack directory before any `self_host_*` IPC operation may inspect or write to it.
pub trait NativeStackFolderPicker: Send + Sync {
    fn pick_community_stack_dir(&self) -> Result<Option<PathBuf>, crate::CommunityDeployError>;
}

/// Out-of-process OS folder chooser (`NSOpenPanel` via `/usr/bin/osascript` on macOS,
/// `zenity`/`kdialog` on Linux, STA `FolderBrowserDialog` on Windows) invoked with fixed static
/// argv and zero WebView-supplied path arguments.
pub struct OsNativeStackFolderPicker;

impl OsNativeStackFolderPicker {
    fn parse_selected_folder_stdout(
        raw_bytes: &[u8],
    ) -> Result<PathBuf, crate::CommunityDeployError> {
        let raw = std::str::from_utf8(raw_bytes)
            .map_err(|_| crate::CommunityDeployError::StackDirPickerUnavailable)?;
        let line = raw.trim_end_matches(['\r', '\n']);
        let normalized = if line.len() > 1 && !line.ends_with(":\\") {
            line.trim_end_matches('/')
        } else {
            line
        };
        if normalized.is_empty() {
            return Err(crate::CommunityDeployError::StackDirPickerUnavailable);
        }
        Ok(PathBuf::from(normalized))
    }
}

impl NativeStackFolderPicker for OsNativeStackFolderPicker {
    fn pick_community_stack_dir(&self) -> Result<Option<PathBuf>, crate::CommunityDeployError> {
        #[cfg(target_os = "macos")]
        {
            let output = std::process::Command::new("/usr/bin/osascript")
                .args([
                    "-e",
                    "POSIX path of (choose folder with prompt \"Select Kodera Community stack folder\")",
                ])
                .stdin(std::process::Stdio::null())
                .output()
                .map_err(|_| crate::CommunityDeployError::StackDirPickerUnavailable)?;
            if output.status.success() {
                return Self::parse_selected_folder_stdout(&output.stdout).map(Some);
            }
            let stderr = String::from_utf8_lossy(&output.stderr);
            if stderr.contains("(-128)") || stderr.to_ascii_lowercase().contains("canceled") {
                return Ok(None);
            }
            Err(crate::CommunityDeployError::StackDirPickerUnavailable)
        }

        #[cfg(all(unix, not(target_os = "macos")))]
        {
            match std::process::Command::new("/usr/bin/zenity")
                .args([
                    "--file-selection",
                    "--directory",
                    "--title=Select Kodera Community stack folder",
                ])
                .stdin(std::process::Stdio::null())
                .output()
            {
                Ok(output) if output.status.success() => {
                    return Self::parse_selected_folder_stdout(&output.stdout).map(Some);
                }
                Ok(output) if output.status.code() == Some(1) => return Ok(None),
                Ok(_) => return Err(crate::CommunityDeployError::StackDirPickerUnavailable),
                Err(err) if err.kind() == std::io::ErrorKind::NotFound => {}
                Err(_) => return Err(crate::CommunityDeployError::StackDirPickerUnavailable),
            }

            let output = std::process::Command::new("/usr/bin/kdialog")
                .args([
                    "--getexistingdirectory",
                    ".",
                    "--title",
                    "Select Kodera Community stack folder",
                ])
                .stdin(std::process::Stdio::null())
                .output()
                .map_err(|_| crate::CommunityDeployError::StackDirPickerUnavailable)?;
            if output.status.success() {
                return Self::parse_selected_folder_stdout(&output.stdout).map(Some);
            }
            if output.status.code() == Some(1) {
                return Ok(None);
            }
            Err(crate::CommunityDeployError::StackDirPickerUnavailable)
        }

        #[cfg(target_os = "windows")]
        {
            let output = std::process::Command::new("powershell.exe")
                .args([
                    "-NoProfile",
                    "-NonInteractive",
                    "-STA",
                    "-Command",
                    "Add-Type -AssemblyName System.Windows.Forms; $d = New-Object System.Windows.Forms.FolderBrowserDialog; $d.Description = 'Select Kodera Community stack folder'; $d.ShowNewFolderButton = $false; if ($d.ShowDialog() -eq [System.Windows.Forms.DialogResult]::OK) { [Console]::Out.WriteLine($d.SelectedPath); exit 0 } else { exit 128 }",
                ])
                .stdin(std::process::Stdio::null())
                .output()
                .map_err(|_| crate::CommunityDeployError::StackDirPickerUnavailable)?;
            if output.status.success() {
                return Self::parse_selected_folder_stdout(&output.stdout).map(Some);
            }
            if output.status.code() == Some(128) {
                return Ok(None);
            }
            Err(crate::CommunityDeployError::StackDirPickerUnavailable)
        }
    }
}
