pub(super) use super::ipc_bridge::IpcEnvelopeHeader;
#[cfg(feature = "desktop-app")]
pub(super) use super::native_runtime;
use super::*;
use crate::{route_deep_link, verify_embedded_tauri_conf_csp, DeepLinkAdmissionPolicy};
use std::collections::VecDeque;
use std::fs;
use std::path::{Path, PathBuf};

mod ipc_security;
mod navigation_and_assets;
mod wizard_and_window;

pub(super) const ORG: &str = "019a5e62-6ca0-7303-8303-030303030303";

pub(super) struct ScopedTempDir(PathBuf);

impl ScopedTempDir {
    pub(super) fn new(tag: &str) -> Self {
        let nanos = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_nanos())
            .unwrap_or(0);
        let dir = crate::self_host_deploy::non_shared_test_scratch_root().join(format!(
            "kodera-desktop-gui-test-{tag}-{}-{nanos}",
            std::process::id()
        ));
        fs::create_dir_all(&dir).unwrap();
        Self(dir)
    }

    pub(super) fn path(&self) -> &Path {
        &self.0
    }
}

impl Drop for ScopedTempDir {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.0);
    }
}
