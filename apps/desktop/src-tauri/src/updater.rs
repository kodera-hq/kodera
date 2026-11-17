//! Signed macOS updates. Trust configuration is fixed at build time; WebView input never
//! selects a feed, key, archive, destination or helper command. Unconfigured builds fail closed.
use ed25519_dalek::{Signature, VerifyingKey};
#[cfg(target_os = "macos")]
use std::path::Path;
use std::path::PathBuf;

const MAX_MANIFEST_BYTES: usize = 16 * 1024;
#[cfg(target_os = "macos")]
const MAX_ARCHIVE_BYTES: u64 = 512 * 1024 * 1024;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Manifest {
    pub version: String,
    pub url: String,
    pub digest: [u8; 32],
}

fn hex<const N: usize>(raw: &str) -> Result<[u8; N], &'static str> {
    if raw.len() != N * 2
        || !raw
            .bytes()
            .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
    {
        return Err("update_invalid_hex");
    }
    let mut out = [0; N];
    for (i, byte) in out.iter_mut().enumerate() {
        *byte = u8::from_str_radix(&raw[i * 2..i * 2 + 2], 16).map_err(|_| "update_invalid_hex")?;
    }
    Ok(out)
}

fn version(raw: &str) -> Result<[u32; 3], &'static str> {
    let pieces: Vec<_> = raw.split('.').collect();
    if pieces.len() != 3 {
        return Err("update_invalid_version");
    }
    let mut out = [0; 3];
    for (i, piece) in pieces.iter().enumerate() {
        if piece.is_empty()
            || (piece.len() > 1 && piece.starts_with('0'))
            || !piece.bytes().all(|c| c.is_ascii_digit())
        {
            return Err("update_invalid_version");
        }
        out[i] = piece.parse().map_err(|_| "update_invalid_version")?;
    }
    Ok(out)
}

fn admitted_url(raw: &str) -> bool {
    let Some(rest) = raw.strip_prefix("https://") else {
        return false;
    };
    let Some((host, path)) = rest.split_once('/') else {
        return false;
    };
    !host.is_empty()
        && host
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'.' || b == b'-')
        && !host.starts_with('.')
        && !host.ends_with('.')
        && !host.contains("..")
        && !path.is_empty()
        && !raw.contains("..")
        && raw
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b"-._~/".contains(&b) || b == b':')
}

/// Verify exact manifest bytes before parsing any field. Detached signature and trust key
/// are lowercase hex. No unsigned, checksum-only, downgrade or platform-mismatched update.
pub fn verify_manifest(
    raw: &[u8],
    signature_hex: &str,
    public_key_hex: &str,
    current: &str,
    now: u64,
) -> Result<Manifest, &'static str> {
    if raw.is_empty() || raw.len() > MAX_MANIFEST_BYTES {
        return Err("update_manifest_bounds");
    }
    let key = VerifyingKey::from_bytes(&hex(public_key_hex)?).map_err(|_| "update_invalid_key")?;
    let signature = Signature::from_bytes(&hex(signature_hex.trim())?);
    key.verify_strict(raw, &signature)
        .map_err(|_| "update_invalid_signature")?;
    let doc: serde_json::Value =
        serde_json::from_slice(raw).map_err(|_| "update_invalid_manifest")?;
    let obj = doc.as_object().ok_or("update_invalid_manifest")?;
    let expected = ["version", "platform", "url", "sha256", "expires_at"];
    if obj.len() != expected.len() || expected.iter().any(|k| !obj.contains_key(*k)) {
        return Err("update_invalid_manifest");
    }
    let get = |key| {
        doc.get(key)
            .and_then(serde_json::Value::as_str)
            .ok_or("update_invalid_manifest")
    };
    let next = get("version")?;
    if version(next)? <= version(current)? {
        return Err("update_version_not_newer");
    }
    if get("platform")? != "macos-universal" {
        return Err("update_wrong_platform");
    }
    let expires = doc["expires_at"].as_u64().ok_or("update_invalid_expiry")?;
    if expires <= now || expires > now.saturating_add(30 * 86400) {
        return Err("update_expired");
    }
    let url = get("url")?;
    if !admitted_url(url) || !url.ends_with(".app.tar.gz") {
        return Err("update_untrusted_url");
    }
    Ok(Manifest {
        version: next.to_owned(),
        url: url.to_owned(),
        digest: hex(get("sha256")?)?,
    })
}

#[cfg(any(target_os = "macos", test))]
fn validate_archive_listing(names: &str, detail: &str) -> Result<(), &'static str> {
    let expanded = detail.lines().try_fold(0u64, |sum, line| {
        let size = line
            .split_whitespace()
            .nth(4)
            .and_then(|v| v.parse::<u64>().ok())
            .ok_or("update_unsafe_archive")?;
        sum.checked_add(size)
            .filter(|total| *total <= 1024 * 1024 * 1024)
            .ok_or("update_archive_bounds")
    })?;
    if expanded == 0
        || names.lines().count() > 20000
        || names.lines().any(|p| {
            !(p == "Kodera.app/" || p.starts_with("Kodera.app/"))
                || p.split('/').any(|c| c == ".." || c == ".")
                || p.contains('\\')
                || p.len() > 1024
                || p.chars().any(char::is_control)
        })
        || detail
            .lines()
            .any(|p| !p.starts_with('-') && !p.starts_with('d'))
    {
        return Err("update_unsafe_archive");
    }
    Ok(())
}

#[cfg(any(target_os = "macos", test))]
fn copy_download(
    input: impl std::io::Read,
    output: &mut impl std::io::Write,
    limit: u64,
) -> Result<(), &'static str> {
    let bound = limit.checked_add(1).ok_or("update_download_bounds")?;
    let mut bounded = std::io::Read::take(input, bound);
    let count = std::io::copy(&mut bounded, output).map_err(|_| "update_download_failed")?;
    if count > limit {
        return Err("update_download_bounds");
    }
    Ok(())
}

/// A ready value can only be constructed by native verification, never IPC deserialization.
#[derive(Debug)]
pub struct ReadyUpdate {
    pub version: String,
    stage: PathBuf,
    #[cfg(target_os = "macos")]
    archive_digest: [u8; 32],
    #[cfg(target_os = "macos")]
    installed_app: PathBuf,
}

impl Drop for ReadyUpdate {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.stage);
    }
}

/// Production check is intentionally unavailable without both immutable trust settings.
pub fn check() -> Result<ReadyUpdate, &'static str> {
    let feed = option_env!("KODERA_DESKTOP_UPDATE_FEED").ok_or("update_not_configured")?;
    let key = option_env!("KODERA_DESKTOP_UPDATE_PUBLIC_KEY").ok_or("update_not_configured")?;
    if !admitted_url(feed) || hex::<32>(key).is_err() {
        return Err("update_invalid_configuration");
    }
    #[cfg(target_os = "macos")]
    {
        macos::check(feed, key)
    }
    #[cfg(not(target_os = "macos"))]
    {
        Err("update_platform_unavailable")
    }
}

impl ReadyUpdate {
    /// Recheck the signed archive and native distribution signature before handing off.
    pub fn restart(self) -> Result<(), &'static str> {
        #[cfg(target_os = "macos")]
        {
            macos::restart(self)
        }
        #[cfg(not(target_os = "macos"))]
        {
            Err("update_platform_unavailable")
        }
    }
}

#[cfg(target_os = "macos")]
mod macos {
    use super::*;
    use std::fs;
    use std::io::Read;
    use std::os::unix::fs::DirBuilderExt;
    use std::process::{Command, Stdio};
    fn run(bin: &str, args: &[&std::ffi::OsStr]) -> Result<Vec<u8>, &'static str> {
        let mut child = Command::new(bin)
            .args(args)
            .stdin(Stdio::null())
            .stdout(Stdio::piped())
            .stderr(Stdio::null())
            .spawn()
            .map_err(|_| "update_command_failed")?;
        let mut bytes = Vec::new();
        let read = child
            .stdout
            .take()
            .ok_or("update_command_failed")?
            .take(4 * 1024 * 1024 + 1)
            .read_to_end(&mut bytes);
        if read.is_err() || bytes.len() > 4 * 1024 * 1024 {
            let _ = child.kill();
            let _ = child.wait();
            return Err("update_command_bounds");
        }
        if !child.wait().map_err(|_| "update_command_failed")?.success() {
            return Err("update_command_failed");
        }
        Ok(bytes)
    }

    fn download(url: &str, path: &Path, limit: u64) -> Result<(), &'static str> {
        // Bound streamed bytes independently of Content-Length and the platform curl version.
        // Redirects are refused, the user curl configuration is disabled, and TLS is mandatory.
        let mut child = Command::new("/usr/bin/curl")
            .args([
                "--disable",
                "--fail",
                "--silent",
                "--show-error",
                "--proto",
                "=https",
                "--tlsv1.2",
                "--max-time",
                "180",
                url,
            ])
            .stdin(Stdio::null())
            .stdout(Stdio::piped())
            .stderr(Stdio::null())
            .spawn()
            .map_err(|_| "update_download_failed")?;
        let copied = (|| {
            let mut file = fs::OpenOptions::new()
                .write(true)
                .create_new(true)
                .open(path)
                .map_err(|_| "update_download_failed")?;
            let stream = child.stdout.take().ok_or("update_download_failed")?;
            copy_download(stream, &mut file, limit)?;
            Ok(())
        })();
        if copied.is_err() {
            let _ = child.kill();
        }
        let status = child.wait().map_err(|_| "update_download_failed")?;
        copied?;
        if !status.success() {
            return Err("update_download_failed");
        }
        Ok(())
    }

    fn signed_app(path: &Path) -> Result<(), &'static str> {
        run(
            "/usr/bin/codesign",
            &[
                "--verify".as_ref(),
                "--deep".as_ref(),
                "--strict".as_ref(),
                path.as_os_str(),
            ],
        )?;
        run(
            "/usr/sbin/spctl",
            &[
                "--assess".as_ref(),
                "--type".as_ref(),
                "execute".as_ref(),
                path.as_os_str(),
            ],
        )?;
        Ok(())
    }
    fn extract(stage: &Path, expected_version: &str) -> Result<PathBuf, &'static str> {
        let archive = stage.join("update.app.tar.gz");
        let listing = run("/usr/bin/tar", &["-tzf".as_ref(), archive.as_os_str()])?;
        let types = run(
            "/usr/bin/tar",
            &[
                "--numeric-owner".as_ref(),
                "-tvzf".as_ref(),
                archive.as_os_str(),
            ],
        )?;
        let names = std::str::from_utf8(&listing).map_err(|_| "update_unsafe_archive")?;
        let detail = std::str::from_utf8(&types).map_err(|_| "update_unsafe_archive")?;
        validate_archive_listing(names, detail)?;
        let unpacked = stage.join("unpacked");
        let _ = fs::remove_dir_all(&unpacked);
        fs::create_dir(&unpacked).map_err(|_| "update_stage_failed")?;
        run(
            "/usr/bin/tar",
            &[
                "-xzf".as_ref(),
                archive.as_os_str(),
                "-C".as_ref(),
                unpacked.as_os_str(),
            ],
        )?;
        let app = unpacked.join("Kodera.app");
        signed_app(&app)?;
        let plist = app.join("Contents/Info.plist");
        for (field, expected) in [
            ("CFBundleIdentifier", crate::DESKTOP_APP_IDENTIFIER),
            ("CFBundleShortVersionString", expected_version),
        ] {
            let actual = run(
                "/usr/libexec/PlistBuddy",
                &[
                    "-c".as_ref(),
                    format!("Print:{field}").as_ref(),
                    plist.as_os_str(),
                ],
            )?;
            if std::str::from_utf8(&actual)
                .map_err(|_| "update_bundle_mismatch")?
                .trim()
                != expected
            {
                return Err("update_bundle_mismatch");
            }
        }
        let exe = app.join("Contents/MacOS/kodera-desktop");
        run(
            "/usr/bin/lipo",
            &[
                "-verify_arch".as_ref(),
                "arm64".as_ref(),
                "x86_64".as_ref(),
                exe.as_os_str(),
            ],
        )?;
        Ok(app)
    }
    pub(super) fn check(feed: &str, key: &str) -> Result<ReadyUpdate, &'static str> {
        let exe = std::env::current_exe().map_err(|_| "update_not_installed")?;
        let app = exe
            .parent()
            .and_then(Path::parent)
            .and_then(Path::parent)
            .ok_or("update_not_installed")?;
        if app.extension().and_then(|e| e.to_str()) != Some("app")
            || !app.join("Contents/Info.plist").is_file()
        {
            return Err("update_not_installed");
        }
        signed_app(app)?;
        // Stage beside the installed app to guarantee same-volume atomic rename and to prove
        // write access before offering Restart. No privilege escalation or admin prompt.
        let mut random = [0; 16];
        getrandom::fill(&mut random).map_err(|_| "update_entropy_failed")?;
        let suffix: String = random.iter().map(|v| format!("{v:02x}")).collect();
        let stage = app
            .parent()
            .ok_or("update_not_installed")?
            .join(format!(".kodera-update-{suffix}"));
        fs::DirBuilder::new()
            .mode(0o700)
            .create(&stage)
            .map_err(|_| "update_stage_failed")?;
        let mut ready = ReadyUpdate {
            version: String::new(),
            stage,
            archive_digest: [0; 32],
            installed_app: app.to_owned(),
        };
        let manifest_path = ready.stage.join("manifest.json");
        let signature_path = ready.stage.join("manifest.sig");
        download(feed, &manifest_path, MAX_MANIFEST_BYTES as u64)?;
        download(&format!("{feed}.sig"), &signature_path, 256)?;
        let now = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map_err(|_| "update_invalid_clock")?
            .as_secs();
        let manifest = verify_manifest(
            &fs::read(manifest_path).map_err(|_| "update_manifest_missing")?,
            &fs::read_to_string(signature_path).map_err(|_| "update_signature_missing")?,
            key,
            crate::DESKTOP_APP_VERSION,
            now,
        )?;
        let archive = ready.stage.join("update.app.tar.gz");
        download(&manifest.url, &archive, MAX_ARCHIVE_BYTES)?;
        if kodera_rs::sha256(&fs::read(&archive).map_err(|_| "update_archive_missing")?)
            != manifest.digest
        {
            return Err("update_hash_mismatch");
        }
        extract(&ready.stage, &manifest.version)?;
        ready.version = manifest.version;
        ready.archive_digest = manifest.digest;
        Ok(ready)
    }
    pub(super) fn restart(ready: ReadyUpdate) -> Result<(), &'static str> {
        let now = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map_err(|_| "update_invalid_clock")?
            .as_secs();
        let manifest = verify_manifest(
            &fs::read(ready.stage.join("manifest.json")).map_err(|_| "update_manifest_missing")?,
            &fs::read_to_string(ready.stage.join("manifest.sig"))
                .map_err(|_| "update_signature_missing")?,
            option_env!("KODERA_DESKTOP_UPDATE_PUBLIC_KEY").ok_or("update_not_configured")?,
            crate::DESKTOP_APP_VERSION,
            now,
        )?;
        if manifest.version != ready.version || manifest.digest != ready.archive_digest {
            return Err("update_manifest_changed");
        }
        if kodera_rs::sha256(
            &fs::read(ready.stage.join("update.app.tar.gz"))
                .map_err(|_| "update_archive_missing")?,
        ) != ready.archive_digest
        {
            return Err("update_hash_mismatch");
        }
        let app = extract(&ready.stage, &manifest.version)?;
        let helper = ready.stage.join("restart.sh");
        fs::write(&helper, include_str!("../assets/restart-update.sh"))
            .map_err(|_| "update_helper_failed")?;
        // The fixed script receives paths solely as positional arguments, never executable text.
        Command::new("/bin/sh")
            .arg(&helper)
            .arg(std::process::id().to_string())
            .arg(&ready.installed_app)
            .arg(&app)
            .arg(&ready.stage)
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .spawn()
            .map_err(|_| "update_helper_failed")?;
        // Ownership transfers to the helper, which removes staging after replacement/rollback.
        std::mem::forget(ready);
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use ed25519_dalek::{Signer, SigningKey};
    fn fixture() -> (Vec<u8>, String, String) {
        // Deterministic throwaway fixture key, never a release trust anchor.
        let key = SigningKey::from_bytes(&[23; 32]);
        let raw = br#"{"version":"0.1.1","platform":"macos-universal","url":"https://releases.example.org/Kodera.app.tar.gz","sha256":"0101010101010101010101010101010101010101010101010101010101010101","expires_at":2000}"#.to_vec();
        let encode = |bytes: &[u8]| bytes.iter().map(|v| format!("{v:02x}")).collect::<String>();
        let sig = encode(&key.sign(&raw).to_bytes());
        (raw, sig, encode(key.verifying_key().as_bytes()))
    }
    #[test]
    fn accepts_only_signed_fresh_newer_manifest() {
        let (raw, sig, key) = fixture();
        assert_eq!(
            verify_manifest(&raw, &sig, &key, "0.1.0", 1000)
                .unwrap()
                .version,
            "0.1.1"
        );
        assert!(verify_manifest(&raw, "", &key, "0.1.0", 1000).is_err());
        assert!(verify_manifest(&raw, &sig, &"00".repeat(32), "0.1.0", 1000).is_err());
        assert!(verify_manifest(&raw, &sig, &key, "0.1.1", 1000).is_err());
        assert!(verify_manifest(&raw, &sig, &key, "0.2.0", 1000).is_err());
        assert!(verify_manifest(&raw, &sig, &key, "0.1.0", 2000).is_err());
        let mut tampered = raw;
        tampered[15] ^= 1;
        assert!(verify_manifest(&tampered, &sig, &key, "0.1.0", 1000).is_err());
    }
    #[test]
    fn signed_malformed_platform_url_and_expiry_are_refused() {
        let (raw, _, key) = fixture();
        let signer = SigningKey::from_bytes(&[23; 32]);
        for (from, to) in [
            ("macos-universal", "linux-x86_64"),
            ("https://", "http://"),
            ("releases.example.org", "evil@releases.example.org"),
            ("0.1.1", "01.1.1"),
            ("2000", "99999999"),
            ("sha256", "digest"),
        ] {
            let altered = String::from_utf8(raw.clone()).unwrap().replace(from, to);
            let sig: String = signer
                .sign(altered.as_bytes())
                .to_bytes()
                .iter()
                .map(|v| format!("{v:02x}"))
                .collect();
            assert!(
                verify_manifest(altered.as_bytes(), &sig, &key, "0.1.0", 1000).is_err(),
                "accepted {to}"
            );
        }
    }
    #[test]
    fn archive_listing_refuses_links_traversal_and_expansion() {
        let valid = "-rw-r--r--  0 501 20 128 Nov 17 00:00 Kodera.app/Contents/Info.plist\n";
        assert!(validate_archive_listing("Kodera.app/Contents/Info.plist\n", valid).is_ok());
        for names in [
            "../outside",
            "Kodera.app/../outside",
            "/Kodera.app/Contents",
            "Kodera.app/./file",
            "Kodera.app/line\tfile",
        ] {
            assert!(validate_archive_listing(names, valid).is_err());
        }
        for detail in [
            "lrwxr-xr-x 0 501 20 128 Nov 17 00:00 link",
            "hrw-r--r-- 0 501 20 128 Nov 17 00:00 link",
            "-rw-r--r-- 0 501 20 9999999999 Nov 17 00:00 file",
        ] {
            assert!(validate_archive_listing("Kodera.app/Contents/file", detail).is_err());
        }
    }
    #[test]
    fn streamed_download_bound_does_not_trust_a_declared_length() {
        let mut output = Vec::new();
        assert_eq!(
            copy_download(std::io::repeat(1), &mut output, 8),
            Err("update_download_bounds")
        );
        assert_eq!(output.len(), 9);
        output.clear();
        assert!(copy_download(&b"complete"[..], &mut output, 8).is_ok());
        assert_eq!(output, b"complete");
    }
}
