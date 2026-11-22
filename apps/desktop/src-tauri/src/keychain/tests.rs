use super::os_backend::{
    format_macos_security_interactive_store_line, resolve_windows_powershell_program_from_root,
    DebugVaultKeychainBackend, WINDOWS_PASSWORD_VAULT_COMMAND,
};
use super::*;
use std::collections::BTreeMap;
use std::fs;
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::time::{Duration, Instant};
use zeroize::Zeroizing;

const ORG: &str = "019a5e62-6ca0-7303-8303-030303030303";
const OTHER_ORG: &str = "019a5e62-6ca0-7303-8303-030303030304";
const SAMPLE_OPAQUE_PAYLOAD: &str = "syt_sample_opaque_fixture_0123456789";

fn unescape_macos_interactive_arg(escaped: &str) -> String {
    let mut out = String::with_capacity(escaped.len());
    let mut chars = escaped.chars();
    while let Some(ch) = chars.next() {
        if ch == '\\' {
            if let Some(next) = chars.next() {
                out.push(next);
            } else {
                out.push('\\');
            }
        } else {
            out.push(ch);
        }
    }
    out
}

fn fresh_keychain_test_dir(tag: &str) -> PathBuf {
    static SEQ: AtomicU64 = AtomicU64::new(1);
    let id = SEQ.fetch_add(1, Ordering::Relaxed);
    let dir = crate::self_host_deploy::non_shared_test_scratch_root()
        .join(format!("kodera-keychain-{tag}-{}-{id}", std::process::id()));
    let _ = fs::remove_dir_all(&dir);
    fs::create_dir_all(&dir).unwrap();
    dir
}

#[derive(Default)]
struct RecordedOsKeychainRunner {
    platform: Option<OsKeychainPlatform>,
    missing: AtomicBool,
    fail_all: AtomicBool,
    fail_delete: AtomicBool,
    timeout_all: AtomicBool,
    vault: Mutex<BTreeMap<(String, String), String>>,
    invocations: Mutex<Vec<(String, Vec<String>, String)>>,
}

impl RecordedOsKeychainRunner {
    fn for_platform(platform: OsKeychainPlatform) -> Arc<Self> {
        Arc::new(Self {
            platform: Some(platform),
            missing: AtomicBool::new(false),
            fail_all: AtomicBool::new(false),
            fail_delete: AtomicBool::new(false),
            timeout_all: AtomicBool::new(false),
            vault: Mutex::new(BTreeMap::new()),
            invocations: Mutex::new(Vec::new()),
        })
    }
}

impl OsKeychainProcessRunner for RecordedOsKeychainRunner {
    fn run_piped(
        &self,
        program: &str,
        args: &[String],
        stdin_bytes: Option<&[u8]>,
    ) -> Result<OsKeychainExecOutput, KeychainError> {
        let stdin_str = stdin_bytes
            .map(|b| String::from_utf8(b.to_vec()).unwrap())
            .unwrap_or_default();
        self.invocations.lock().unwrap().push((
            program.to_owned(),
            args.to_vec(),
            stdin_str.clone(),
        ));
        if self.timeout_all.load(Ordering::SeqCst) {
            return Ok(OsKeychainExecOutput {
                status_code: None,
                stdout: Zeroizing::new(Vec::new()),
                stderr_has_bytes: false,
                missing_program: false,
                timed_out: true,
            });
        }
        if self.missing.load(Ordering::SeqCst) {
            return Ok(OsKeychainExecOutput {
                status_code: None,
                stdout: Zeroizing::new(Vec::new()),
                stderr_has_bytes: false,
                missing_program: true,
                timed_out: false,
            });
        }
        if self.fail_all.load(Ordering::SeqCst) {
            return Ok(OsKeychainExecOutput {
                status_code: Some(1),
                stdout: Zeroizing::new(Vec::new()),
                stderr_has_bytes: true,
                missing_program: false,
                timed_out: false,
            });
        }
        let mut vault = self.vault.lock().unwrap();
        match self.platform.expect("platform configured") {
            OsKeychainPlatform::MacOsSecurity => {
                if args == ["-i"] {
                    let trimmed = stdin_str.trim_end_matches('\n');
                    let rest = trimmed
                        .strip_prefix("add-generic-password -U -s \"")
                        .expect("expected macos store prefix");
                    let (svc, rest) = rest.split_once("\" -a \"").unwrap();
                    let (acct, rest) = rest.split_once("\" -w \"").unwrap();
                    let escaped_sec = rest.strip_suffix('"').unwrap();
                    let unescaped = unescape_macos_interactive_arg(escaped_sec);
                    vault.insert((svc.to_owned(), acct.to_owned()), unescaped);
                    Ok(OsKeychainExecOutput {
                        status_code: Some(0),
                        stdout: Zeroizing::new(Vec::new()),
                        stderr_has_bytes: false,
                        missing_program: false,
                        timed_out: false,
                    })
                } else if args.first().map(String::as_str) == Some("find-generic-password") {
                    let key = (args[2].clone(), args[4].clone());
                    if let Some(sec) = vault.get(&key) {
                        Ok(OsKeychainExecOutput {
                            status_code: Some(0),
                            stdout: Zeroizing::new(format!("{sec}\n").into_bytes()),
                            stderr_has_bytes: false,
                            missing_program: false,
                            timed_out: false,
                        })
                    } else {
                        Ok(OsKeychainExecOutput {
                            status_code: Some(44),
                            stdout: Zeroizing::new(Vec::new()),
                            stderr_has_bytes: false,
                            missing_program: false,
                            timed_out: false,
                        })
                    }
                } else if args.first().map(String::as_str) == Some("delete-generic-password") {
                    if self.fail_delete.load(Ordering::SeqCst) {
                        return Ok(OsKeychainExecOutput {
                            status_code: Some(36),
                            stdout: Zeroizing::new(Vec::new()),
                            stderr_has_bytes: true,
                            missing_program: false,
                            timed_out: false,
                        });
                    }
                    let key = (args[2].clone(), args[4].clone());
                    let code = if vault.remove(&key).is_some() { 0 } else { 44 };
                    Ok(OsKeychainExecOutput {
                        status_code: Some(code),
                        stdout: Zeroizing::new(Vec::new()),
                        stderr_has_bytes: false,
                        missing_program: false,
                        timed_out: false,
                    })
                } else {
                    panic!("unexpected macos security args: {args:?}");
                }
            }
            OsKeychainPlatform::LinuxSecretTool => match args.first().map(String::as_str) {
                Some("store") => {
                    let key = (args[3].clone(), args[5].clone());
                    vault.insert(key, stdin_str);
                    Ok(OsKeychainExecOutput {
                        status_code: Some(0),
                        stdout: Zeroizing::new(Vec::new()),
                        stderr_has_bytes: false,
                        missing_program: false,
                        timed_out: false,
                    })
                }
                Some("lookup") => {
                    let key = (args[2].clone(), args[4].clone());
                    if let Some(sec) = vault.get(&key) {
                        Ok(OsKeychainExecOutput {
                            status_code: Some(0),
                            stdout: Zeroizing::new(sec.as_bytes().to_vec()),
                            stderr_has_bytes: false,
                            missing_program: false,
                            timed_out: false,
                        })
                    } else {
                        Ok(OsKeychainExecOutput {
                            status_code: Some(1),
                            stdout: Zeroizing::new(Vec::new()),
                            stderr_has_bytes: false,
                            missing_program: false,
                            timed_out: false,
                        })
                    }
                }
                Some("clear") => {
                    if self.fail_delete.load(Ordering::SeqCst) {
                        return Ok(OsKeychainExecOutput {
                            status_code: Some(1),
                            stdout: Zeroizing::new(Vec::new()),
                            stderr_has_bytes: true,
                            missing_program: false,
                            timed_out: false,
                        });
                    }
                    let key = (args[2].clone(), args[4].clone());
                    let existed = vault.remove(&key).is_some();
                    Ok(OsKeychainExecOutput {
                        status_code: Some(if existed { 0 } else { 1 }),
                        stdout: Zeroizing::new(Vec::new()),
                        stderr_has_bytes: false,
                        missing_program: false,
                        timed_out: false,
                    })
                }
                _ => panic!("unexpected secret-tool args: {args:?}"),
            },
            OsKeychainPlatform::WindowsPasswordVault => {
                let line = stdin_str.trim_end_matches('\n');
                let parts: Vec<&str> = line.splitn(4, '\t').collect();
                match parts[0] {
                    "store" => {
                        vault.insert(
                            (parts[1].to_owned(), parts[2].to_owned()),
                            parts[3].to_owned(),
                        );
                        Ok(OsKeychainExecOutput {
                            status_code: Some(0),
                            stdout: Zeroizing::new(Vec::new()),
                            stderr_has_bytes: false,
                            missing_program: false,
                            timed_out: false,
                        })
                    }
                    "lookup" => {
                        let key = (parts[1].to_owned(), parts[2].to_owned());
                        if let Some(sec) = vault.get(&key) {
                            Ok(OsKeychainExecOutput {
                                status_code: Some(0),
                                stdout: Zeroizing::new(sec.as_bytes().to_vec()),
                                stderr_has_bytes: false,
                                missing_program: false,
                                timed_out: false,
                            })
                        } else {
                            Ok(OsKeychainExecOutput {
                                status_code: Some(44),
                                stdout: Zeroizing::new(Vec::new()),
                                stderr_has_bytes: false,
                                missing_program: false,
                                timed_out: false,
                            })
                        }
                    }
                    "delete" => {
                        if self.fail_delete.load(Ordering::SeqCst) {
                            return Ok(OsKeychainExecOutput {
                                status_code: Some(1),
                                stdout: Zeroizing::new(Vec::new()),
                                stderr_has_bytes: true,
                                missing_program: false,
                                timed_out: false,
                            });
                        }
                        let key = (parts[1].to_owned(), parts[2].to_owned());
                        let code = if vault.remove(&key).is_some() { 0 } else { 44 };
                        Ok(OsKeychainExecOutput {
                            status_code: Some(code),
                            stdout: Zeroizing::new(Vec::new()),
                            stderr_has_bytes: false,
                            missing_program: false,
                            timed_out: false,
                        })
                    }
                    other => panic!("unexpected windows vault op: {other}"),
                }
            }
        }
    }
}

#[test]
fn builds_and_validates_org_scoped_keychain_slots() {
    let slot =
        build_keychain_slot(KeychainSecretKind::MatrixSession, ORG, "@alice:kodera.io").unwrap();
    assert_eq!(slot.service_name, "io.kodera.desktop.matrix-session");
    let expected_slot = format!("org:{ORG}:user:@alice:kodera.io");
    assert_eq!(slot.account_name, expected_slot);
    assert!(matches!(
        validate_keychain_service_id(&slot.service_name),
        Ok(KeychainSecretKind::MatrixSession)
    ));
    let (parsed_org, parsed_user, parsed_domain) =
        validate_keychain_account_id(&slot.account_name).unwrap();
    assert_eq!(parsed_org.as_str(), ORG);
    assert_eq!(parsed_user, "@alice:kodera.io");
    assert_eq!(parsed_domain, "kodera.io");
}

#[test]
fn rejects_invalid_service_and_account_identifiers() {
    for invalid_svc_candidate in [
        "",
        "io.kodera.desktop",
        "io.kodera.desktop.unknown",
        "com.other.app.matrix-session",
        "io.kodera.desktop.matrix-session\0",
        "io.kodera.desktop.matrix session",
    ] {
        assert!(matches!(
            validate_keychain_service_id(invalid_svc_candidate),
            Err(KeychainError::InvalidServiceIdentifier)
        ));
    }

    for invalid_slot_candidate in [
        "",
        "@alice:kodera.io",
        "org:00000000-0000-0000-0000-000000000000:user:@alice:kodera.io",
        "org:019a5e62-6ca0-7303-8303-030303030303:user:alice:kodera.io",
        "org:019a5e62-6ca0-7303-8303-030303030303:user:@alice:localhost",
        "org:019a5e62-6ca0-7303-8303-030303030303:user:@../alice:kodera.io",
        "org:019a5e62-6ca0-7303-8303-030303030303/user:@alice:kodera.io",
    ] {
        assert!(matches!(
            validate_keychain_account_id(invalid_slot_candidate),
            Err(KeychainError::InvalidAccountIdentifier)
        ));
    }
}

#[test]
fn redacts_secret_in_debug_display_errors_and_blocks_metadata_leaks() {
    let (meta, wrapped) = KeychainSessionMetadata::validate_with_secret(
        KeychainSecretKind::OidcRefresh,
        ORG,
        "@zxxma:community.kodera.io",
        "DEV_MACBOOK_01",
        1_762_520_000,
        Some(1_762_523_600),
        Some(SAMPLE_OPAQUE_PAYLOAD),
    )
    .unwrap();
    let mut redacted_box = wrapped.unwrap();
    let debug_repr = format!("{redacted_box:?}");
    let display_repr = format!("{redacted_box}");
    assert!(!debug_repr.contains(SAMPLE_OPAQUE_PAYLOAD));
    assert!(!display_repr.contains(SAMPLE_OPAQUE_PAYLOAD));
    assert!(debug_repr.contains("REDACTED"));
    assert!(!meta.device_id.contains(SAMPLE_OPAQUE_PAYLOAD));
    assert!(!meta.is_expired(1_762_523_599));
    assert!(meta.is_expired(1_762_523_600));

    redacted_box.clear();
    assert!(redacted_box.expose_for_keychain_write().is_empty());

    let leaked = KeychainSessionMetadata::validate_with_secret(
        KeychainSecretKind::MatrixSession,
        ORG,
        "@zxxma:community.kodera.io",
        &SAMPLE_OPAQUE_PAYLOAD.to_ascii_uppercase(),
        1_762_520_000,
        None,
        Some(SAMPLE_OPAQUE_PAYLOAD),
    );
    assert!(matches!(leaked, Err(KeychainError::SecretLeakedInMetadata)));

    let malformed_fixture = format!("{SAMPLE_OPAQUE_PAYLOAD}\0injected");
    let err = RedactedSessionSecret::new(&malformed_fixture).unwrap_err();
    assert!(matches!(err, KeychainError::SecretInvalidCharacters));
    assert!(!err.to_string().contains("syt_sample"));
}

#[test]
fn credential_store_isolates_organisations_redacts_debug_and_builds_os_specs() {
    let mut store = KeychainCredentialStore::new();
    let stored = store
        .store_credential(
            KeychainSecretKind::MatrixSession,
            ORG,
            "@alice:kodera.io",
            "MACBOOK_PRO_01",
            1_762_520_000,
            None,
            SAMPLE_OPAQUE_PAYLOAD,
        )
        .unwrap();
    assert_eq!(store.slot_count(), 1);
    assert!(!stored.native_keychain);
    assert_eq!(stored.persistence, KeychainPersistence::EphemeralFallback);
    assert!(!format!("{store:?}").contains(SAMPLE_OPAQUE_PAYLOAD));

    let other_status = store
        .load_credential_status(
            KeychainSecretKind::MatrixSession,
            OTHER_ORG,
            "@alice:kodera.io",
        )
        .unwrap();
    assert!(!other_status.present);
    assert!(!other_status.native_keychain);
    assert!(other_status.metadata.is_none());

    let own_status = store
        .load_credential_status(KeychainSecretKind::MatrixSession, ORG, "@alice:kodera.io")
        .unwrap();
    assert!(own_status.present);
    assert_eq!(own_status.metadata.as_ref(), Some(&stored.metadata));

    let (_, loaded_secret) = store
        .load_credential_secret(KeychainSecretKind::MatrixSession, ORG, "@alice:kodera.io")
        .unwrap()
        .unwrap();
    assert_eq!(
        loaded_secret.expose_for_keychain_write(),
        SAMPLE_OPAQUE_PAYLOAD
    );

    for platform in [
        OsKeychainPlatform::MacOsSecurity,
        OsKeychainPlatform::LinuxSecretTool,
        OsKeychainPlatform::WindowsPasswordVault,
    ] {
        let store_spec = OsKeychainCommandSpec::build_store(platform, &stored.slot).unwrap();
        let lookup = OsKeychainCommandSpec::build_lookup(platform, &stored.slot).unwrap();
        let delete = OsKeychainCommandSpec::build_delete(platform, &stored.slot).unwrap();
        assert!(store_spec.secret_via_stdin);
        assert!(!lookup.args.is_empty());
        assert!(!delete.args.is_empty());
    }

    let deleted = store
        .delete_credential(KeychainSecretKind::MatrixSession, ORG, "@alice:kodera.io")
        .unwrap();
    assert!(deleted.present);
    assert_eq!(store.slot_count(), 0);
}

#[test]
fn os_native_backend_persists_across_restarts_never_leaks_argv_and_purges_expired_entries() {
    let quoted_secret = r#"syt_quote_"_slash_\_combo_\"_\\"_0123"#;
    for platform in [
        OsKeychainPlatform::MacOsSecurity,
        OsKeychainPlatform::LinuxSecretTool,
        OsKeychainPlatform::WindowsPasswordVault,
    ] {
        let dir = fresh_keychain_test_dir("os-native");
        let index_path = dir.join("keychain-index.json");
        let now_clock = Arc::new(AtomicU64::new(1_762_520_100));
        let clock_ref = now_clock.clone();
        let runner = RecordedOsKeychainRunner::for_platform(platform);

        let backend = Arc::new(OsNativeKeychainBackend::with_custom_runner(
            platform,
            Some(index_path.clone()),
            runner.clone(),
            Arc::new(move || clock_ref.load(Ordering::SeqCst)),
            true,
        ));

        // Process 1: store credential, verify index permissions + zero secret in index & argv, then clear RAM cache.
        let mut store_one = KeychainCredentialStore::with_backend(backend.clone());
        let outcome = store_one
            .store_credential(
                KeychainSecretKind::MatrixSession,
                ORG,
                "@alice:kodera.io",
                "MACBOOK_PRO_01",
                1_762_520_000,
                Some(1_762_523_600),
                quoted_secret,
            )
            .unwrap();
        assert!(outcome.native_keychain);
        assert_eq!(outcome.persistence, KeychainPersistence::NativeOsKeychain);

        let index_disk = fs::read_to_string(&index_path).unwrap();
        assert!(!index_disk.contains(quoted_secret));
        assert!(!index_disk.contains("syt_quote"));
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let mode = fs::metadata(&index_path).unwrap().permissions().mode() & 0o777;
            assert_eq!(mode, 0o600);
        }

        // Verify zero CLI argv element ever carried the secret.
        for (_, argv, _) in runner.invocations.lock().unwrap().iter() {
            for arg in argv {
                assert!(
                    !arg.contains("syt_quote"),
                    "CLI argv leaked secret on {platform:?}: {arg}"
                );
            }
        }

        // Window close / process exit clears RAM cache ONLY — OS keychain + index persist!
        store_one.clear_ram_cache();
        assert_eq!(store_one.slot_count(), 0);
        drop(store_one);

        // Process 2: reload status and secret from persistent OS keychain + index.
        let mut store_two = KeychainCredentialStore::with_backend(backend.clone());
        let status = store_two
            .load_credential_status(KeychainSecretKind::MatrixSession, ORG, "@alice:kodera.io")
            .unwrap();
        assert!(status.present);
        assert!(status.native_keychain);
        assert_eq!(
            status.metadata.as_ref().unwrap().device_id,
            "MACBOOK_PRO_01"
        );

        let (_, reloaded_secret) = store_two
            .load_credential_secret(KeychainSecretKind::MatrixSession, ORG, "@alice:kodera.io")
            .unwrap()
            .unwrap();
        assert_eq!(reloaded_secret.expose_for_keychain_write(), quoted_secret);

        // Advance clock past `expires_at_unix_secs` -> automatic purge from BOTH index and OS keychain!
        now_clock.store(1_762_523_600, Ordering::SeqCst);
        let expired_status = store_two
            .load_credential_status(KeychainSecretKind::MatrixSession, ORG, "@alice:kodera.io")
            .unwrap();
        assert!(!expired_status.present);
        assert!(!expired_status.native_keychain);
        assert!(runner.vault.lock().unwrap().is_empty());
        assert!(!fs::read_to_string(&index_path)
            .unwrap()
            .contains("MACBOOK_PRO_01"));

        // Re-store, then delete externally in OS vault -> orphaned index entry is auto-cleaned!
        let _ = store_two
            .store_credential(
                KeychainSecretKind::OidcRefresh,
                ORG,
                "@alice:kodera.io",
                "MACBOOK_PRO_02",
                1_762_524_000,
                None,
                SAMPLE_OPAQUE_PAYLOAD,
            )
            .unwrap();
        runner.vault.lock().unwrap().clear();
        let orphan_status = store_two
            .load_credential_status(KeychainSecretKind::OidcRefresh, ORG, "@alice:kodera.io")
            .unwrap();
        assert!(!orphan_status.present);
        assert!(!fs::read_to_string(&index_path)
            .unwrap()
            .contains("MACBOOK_PRO_02"));

        let _ = fs::remove_dir_all(&dir);
    }
}

#[test]
fn macos_interactive_stdin_rejects_injection_and_linux_headless_falls_back_cleanly() {
    let secret = RedactedSessionSecret::new(SAMPLE_OPAQUE_PAYLOAD).unwrap();
    let bad_slot = KeychainSlotDescriptor {
        secret_kind: KeychainSecretKind::MatrixSession,
        service_name: "io.kodera.desktop.matrix-session".to_owned(),
        account_name: format!("org:{ORG}:user:@alice\":kodera.io"),
    };
    assert!(format_macos_security_interactive_store_line(&bad_slot, &secret).is_err());

    // Headless Linux fallback when DBUS_SESSION_BUS_ADDRESS is absent or secret-tool is missing/locked.
    let dir = fresh_keychain_test_dir("linux-headless");
    let index_path = dir.join("keychain-index.json");
    for (dbus_present, missing_bin, locked_daemon) in [
        (false, false, false),
        (true, true, false),
        (true, false, true),
    ] {
        let runner = Arc::new(RecordedOsKeychainRunner {
            platform: Some(OsKeychainPlatform::LinuxSecretTool),
            missing: AtomicBool::new(missing_bin),
            fail_all: AtomicBool::new(locked_daemon),
            fail_delete: AtomicBool::new(false),
            timeout_all: AtomicBool::new(false),
            vault: Mutex::new(BTreeMap::new()),
            invocations: Mutex::new(Vec::new()),
        });
        let backend = Arc::new(OsNativeKeychainBackend::with_custom_runner(
            OsKeychainPlatform::LinuxSecretTool,
            Some(index_path.clone()),
            runner,
            Arc::new(|| 1_762_520_100),
            dbus_present,
        ));
        let mut store = KeychainCredentialStore::with_backend(backend);
        let stored = store
            .store_credential(
                KeychainSecretKind::MatrixSession,
                ORG,
                "@alice:kodera.io",
                "HEADLESS_CI",
                1_762_520_000,
                None,
                SAMPLE_OPAQUE_PAYLOAD,
            )
            .unwrap();
        assert!(!stored.native_keychain);
        assert_eq!(stored.persistence, KeychainPersistence::EphemeralFallback);

        let loaded = store
            .load_credential_status(KeychainSecretKind::MatrixSession, ORG, "@alice:kodera.io")
            .unwrap();
        assert!(loaded.present);
        assert!(!loaded.native_keychain);

        store.clear_ram_cache();
        let after_teardown = store
            .load_credential_status(KeychainSecretKind::MatrixSession, ORG, "@alice:kodera.io")
            .unwrap();
        assert!(!after_teardown.present);
    }

    // Debug vault backend persists across separate instances and enforces explicit deletion.
    let vault_path = dir.join("debug-vault.json");
    let vault_one = Arc::new(DebugVaultKeychainBackend::new(vault_path.clone()));
    let mut s1 = KeychainCredentialStore::with_backend(vault_one);
    let out1 = s1
        .store_credential(
            KeychainSecretKind::MlsStoreKey,
            ORG,
            "@alice:kodera.io",
            "DEBUG_VAULT_01",
            1_762_520_000,
            None,
            SAMPLE_OPAQUE_PAYLOAD,
        )
        .unwrap();
    assert!(out1.native_keychain);
    s1.clear_ram_cache();
    drop(s1);

    let vault_two = Arc::new(DebugVaultKeychainBackend::new(vault_path));
    let mut s2 = KeychainCredentialStore::with_backend(vault_two);
    let loaded2 = s2
        .load_credential_status(KeychainSecretKind::MlsStoreKey, ORG, "@alice:kodera.io")
        .unwrap();
    assert!(loaded2.present && loaded2.native_keychain);
    assert_eq!(s2.clear_organisation(ORG).unwrap(), 1);
    assert!(
        !s2.load_credential_status(KeychainSecretKind::MlsStoreKey, ORG, "@alice:kodera.io")
            .unwrap()
            .present
    );

    #[cfg(unix)]
    {
        let std_runner = StdOsKeychainProcessRunner::new();
        let echoed = std_runner
            .run_piped("/bin/cat", &[], Some(b"piped_fixture_payload"))
            .unwrap();
        assert_eq!(echoed.status_code, Some(0));
        assert_eq!(&*echoed.stdout, b"piped_fixture_payload");
        let missing = std_runner
            .run_piped("/nonexistent/kodera-missing-helper", &[], None)
            .unwrap();
        assert!(missing.missing_program);
    }

    let _ = fs::remove_dir_all(&dir);
}

#[test]
fn failed_os_deletion_preserves_index_entries_and_succeeds_on_retry() {
    for platform in [
        OsKeychainPlatform::MacOsSecurity,
        OsKeychainPlatform::LinuxSecretTool,
        OsKeychainPlatform::WindowsPasswordVault,
    ] {
        let dir = fresh_keychain_test_dir("delete-retry");
        let index_path = dir.join("keychain-index.json");
        let runner = RecordedOsKeychainRunner::for_platform(platform);
        let backend = Arc::new(OsNativeKeychainBackend::with_custom_runner(
            platform,
            Some(index_path.clone()),
            runner.clone(),
            Arc::new(|| 1_762_520_100),
            true,
        ));
        let mut store = KeychainCredentialStore::with_backend(backend);

        store
            .store_credential(
                KeychainSecretKind::MatrixSession,
                ORG,
                "@alice:kodera.io",
                "DEL_RETRY_01",
                1_762_520_000,
                None,
                SAMPLE_OPAQUE_PAYLOAD,
            )
            .unwrap();
        store
            .store_credential(
                KeychainSecretKind::OidcRefresh,
                ORG,
                "@alice:kodera.io",
                "DEL_RETRY_02",
                1_762_520_000,
                None,
                SAMPLE_OPAQUE_PAYLOAD,
            )
            .unwrap();

        // Simulate OS deletion failure -> index entries MUST stay intact and errors propagate!
        runner.fail_delete.store(true, Ordering::SeqCst);
        assert!(matches!(
            store.delete_credential(KeychainSecretKind::MatrixSession, ORG, "@alice:kodera.io"),
            Err(KeychainError::BackendFailure)
        ));
        let index_after_failed_delete = fs::read_to_string(&index_path).unwrap();
        assert!(index_after_failed_delete.contains("DEL_RETRY_01"));
        assert_eq!(runner.vault.lock().unwrap().len(), 2);

        assert!(matches!(
            store.clear_organisation(ORG),
            Err(KeychainError::BackendFailure)
        ));
        let index_after_failed_clear = fs::read_to_string(&index_path).unwrap();
        assert!(index_after_failed_clear.contains("DEL_RETRY_01"));
        assert!(index_after_failed_clear.contains("DEL_RETRY_02"));

        // OS recovers -> retry deletes from OS vault first, then removes index entries!
        runner.fail_delete.store(false, Ordering::SeqCst);
        let deleted = store
            .delete_credential(KeychainSecretKind::MatrixSession, ORG, "@alice:kodera.io")
            .unwrap();
        assert!(deleted.present && deleted.native_keychain);
        assert!(!fs::read_to_string(&index_path)
            .unwrap()
            .contains("DEL_RETRY_01"));

        let cleared_count = store.clear_organisation(ORG).unwrap();
        assert_eq!(cleared_count, 1);
        assert!(runner.vault.lock().unwrap().is_empty());
        assert!(!fs::read_to_string(&index_path)
            .unwrap()
            .contains("DEL_RETRY_02"));

        let _ = fs::remove_dir_all(&dir);
    }
}

#[test]
fn linux_temporary_outage_retains_index_entries_unlike_confirmed_absence() {
    let dir = fresh_keychain_test_dir("linux-outage");
    let index_path = dir.join("keychain-index.json");
    let runner = RecordedOsKeychainRunner::for_platform(OsKeychainPlatform::LinuxSecretTool);
    let backend_ok = Arc::new(OsNativeKeychainBackend::with_custom_runner(
        OsKeychainPlatform::LinuxSecretTool,
        Some(index_path.clone()),
        runner.clone(),
        Arc::new(|| 1_762_520_100),
        true,
    ));
    let mut store = KeychainCredentialStore::with_backend(backend_ok.clone());
    store
        .store_credential(
            KeychainSecretKind::MatrixSession,
            ORG,
            "@alice:kodera.io",
            "LINUX_DESKTOP_01",
            1_762_520_000,
            None,
            SAMPLE_OPAQUE_PAYLOAD,
        )
        .unwrap();
    store.clear_ram_cache();

    // 1. D-Bus error output on stderr (exit 1 + stderr_has_bytes) -> BackendUnavailable, index retained!
    runner.fail_all.store(true, Ordering::SeqCst);
    assert!(matches!(
        store.load_credential_status(KeychainSecretKind::MatrixSession, ORG, "@alice:kodera.io"),
        Err(KeychainError::BackendUnavailable)
    ));
    assert!(matches!(
        store.load_credential_secret(KeychainSecretKind::MatrixSession, ORG, "@alice:kodera.io"),
        Err(KeychainError::BackendUnavailable)
    ));
    assert!(fs::read_to_string(&index_path)
        .unwrap()
        .contains("LINUX_DESKTOP_01"));
    runner.fail_all.store(false, Ordering::SeqCst);

    // 2. Missing binary -> BackendUnavailable, index retained!
    runner.missing.store(true, Ordering::SeqCst);
    assert!(matches!(
        store.load_credential_status(KeychainSecretKind::MatrixSession, ORG, "@alice:kodera.io"),
        Err(KeychainError::BackendUnavailable)
    ));
    assert!(fs::read_to_string(&index_path)
        .unwrap()
        .contains("LINUX_DESKTOP_01"));
    runner.missing.store(false, Ordering::SeqCst);

    // 3. Unset DBUS_SESSION_BUS_ADDRESS on restart -> BackendUnavailable, index retained!
    let backend_no_dbus = Arc::new(OsNativeKeychainBackend::with_custom_runner(
        OsKeychainPlatform::LinuxSecretTool,
        Some(index_path.clone()),
        runner.clone(),
        Arc::new(|| 1_762_520_100),
        false,
    ));
    let store_no_dbus = KeychainCredentialStore::with_backend(backend_no_dbus);
    assert!(matches!(
        store_no_dbus.load_credential_status(
            KeychainSecretKind::MatrixSession,
            ORG,
            "@alice:kodera.io"
        ),
        Err(KeychainError::BackendUnavailable)
    ));
    assert!(fs::read_to_string(&index_path)
        .unwrap()
        .contains("LINUX_DESKTOP_01"));

    // 4. Timeout -> BackendTimeout, index retained!
    runner.timeout_all.store(true, Ordering::SeqCst);
    assert!(matches!(
        store.load_credential_status(KeychainSecretKind::MatrixSession, ORG, "@alice:kodera.io"),
        Err(KeychainError::BackendTimeout)
    ));
    assert!(fs::read_to_string(&index_path)
        .unwrap()
        .contains("LINUX_DESKTOP_01"));
    runner.timeout_all.store(false, Ordering::SeqCst);

    // 5. Outage resolved -> original secret & metadata load intact!
    let recovered = store
        .load_credential_status(KeychainSecretKind::MatrixSession, ORG, "@alice:kodera.io")
        .unwrap();
    assert!(recovered.present && recovered.native_keychain);

    // 6. Confirmed absence (`exit == 1` with empty stdout & empty stderr) removes orphaned index entry.
    runner.vault.lock().unwrap().clear();
    let absent = store
        .load_credential_status(KeychainSecretKind::MatrixSession, ORG, "@alice:kodera.io")
        .unwrap();
    assert!(!absent.present);
    assert!(!fs::read_to_string(&index_path)
        .unwrap()
        .contains("LINUX_DESKTOP_01"));

    let _ = fs::remove_dir_all(&dir);
}

#[test]
fn enforces_macos_security_interactive_4000_byte_ceiling_and_quote_expansion() {
    let slot =
        build_keychain_slot(KeychainSecretKind::MatrixSession, ORG, "@alice:kodera.io").unwrap();
    let fixed_overhead = b"add-generic-password -U -s \"".len()
        + slot.service_name.len()
        + b"\" -a \"".len()
        + slot.account_name.len()
        + b"\" -w \"".len()
        + b"\"\n".len();

    // Unescaped ASCII secret fits MAX_KEYCHAIN_SECRET_BYTES, producing line <= 4_000 bytes.
    let exact_max_secret_len = MAX_MACOS_SECURITY_INTERACTIVE_LINE_BYTES - fixed_overhead;
    assert!(exact_max_secret_len <= MAX_KEYCHAIN_SECRET_BYTES || MAX_KEYCHAIN_SECRET_BYTES < 4000);

    // Exact boundary test with quote expansion (`"` -> `\"`, 2 bytes each):
    // Construct a secret whose escaped representation hits exact 4_000 bytes vs 4_001 bytes.
    let available_escaped_bytes = MAX_MACOS_SECURITY_INTERACTIVE_LINE_BYTES - fixed_overhead;
    let quote_pairs = 600usize; // 600 `"` chars -> 1_200 escaped bytes
    let plain_tail = available_escaped_bytes - (quote_pairs * 2);
    let exact_boundary_raw = format!("{}{}", "\"".repeat(quote_pairs), "A".repeat(plain_tail));
    let exact_secret = RedactedSessionSecret::new(&exact_boundary_raw).unwrap();
    let encoded_ok = format_macos_security_interactive_store_line(&slot, &exact_secret).unwrap();
    assert_eq!(encoded_ok.len(), MAX_MACOS_SECURITY_INTERACTIVE_LINE_BYTES);

    let one_byte_over_raw = format!("{}{}", "\"".repeat(quote_pairs), "A".repeat(plain_tail + 1));
    let over_secret = RedactedSessionSecret::new(&one_byte_over_raw).unwrap();
    assert!(matches!(
        format_macos_security_interactive_store_line(&slot, &over_secret),
        Err(KeychainError::SecretTooLarge)
    ));

    // Heavy backslash expansion (`\` -> `\\`, 2_200 raw bytes -> 4_400 escaped bytes) is rejected!
    let backslash_heavy = RedactedSessionSecret::new(&"\\".repeat(2_200)).unwrap();
    assert!(matches!(
        format_macos_security_interactive_store_line(&slot, &backslash_heavy),
        Err(KeychainError::SecretTooLarge)
    ));
}

#[test]
fn ephemeral_fallback_enforces_clock_based_expiration() {
    let clock = Arc::new(AtomicU64::new(1_762_520_100));
    let clock_for_backend = clock.clone();
    let backend = Arc::new(EphemeralKeychainBackend::with_clock(Arc::new(move || {
        clock_for_backend.load(Ordering::SeqCst)
    })));
    let mut store = KeychainCredentialStore::with_backend(backend);

    store
        .store_credential(
            KeychainSecretKind::OidcRefresh,
            ORG,
            "@alice:kodera.io",
            "EPHEMERAL_EXP_01",
            1_762_520_000,
            Some(1_762_523_600),
            SAMPLE_OPAQUE_PAYLOAD,
        )
        .unwrap();

    assert!(
        store
            .load_credential_status(KeychainSecretKind::OidcRefresh, ORG, "@alice:kodera.io")
            .unwrap()
            .present
    );
    assert!(store
        .load_credential_secret(KeychainSecretKind::OidcRefresh, ORG, "@alice:kodera.io")
        .unwrap()
        .is_some());

    // Advance clock to expiration boundary -> status and secret both purge and return absent!
    clock.store(1_762_523_600, Ordering::SeqCst);
    let expired_status = store
        .load_credential_status(KeychainSecretKind::OidcRefresh, ORG, "@alice:kodera.io")
        .unwrap();
    assert!(!expired_status.present);
    assert!(expired_status.metadata.is_none());
    assert!(store
        .load_credential_secret(KeychainSecretKind::OidcRefresh, ORG, "@alice:kodera.io")
        .unwrap()
        .is_none());
}

#[test]
fn process_runner_enforces_timeout_drains_concurrent_pipes_and_pins_windows_powershell() {
    assert_eq!(
        resolve_windows_powershell_program_from_root(Some(r"D:\Windows\")),
        r"D:\Windows\System32\WindowsPowerShell\v1.0\powershell.exe"
    );
    for unsafe_root in [
        None,
        Some(""),
        Some(r"..\..\bad"),
        Some("relative\\dir"),
        Some("C:\\Win;bad"),
    ] {
        assert_eq!(
            resolve_windows_powershell_program_from_root(unsafe_root),
            r"C:\Windows\System32\WindowsPowerShell\v1.0\powershell.exe"
        );
    }
    assert!(WINDOWS_PASSWORD_VAULT_COMMAND.contains("-2147023728"));

    #[cfg(unix)]
    {
        // 1. Hanging child AND inherited-pipe grandchild (`sleep 2 & wait`) both return within < 500 ms.
        let fast_timeout_runner =
            StdOsKeychainProcessRunner::with_timeout(Duration::from_millis(80));
        let started = Instant::now();
        let timed_out = fast_timeout_runner
            .run_piped(
                "/bin/sh",
                &["-c".to_owned(), "sleep 2 & wait".to_owned()],
                None,
            )
            .unwrap();
        assert!(timed_out.timed_out);
        assert!(
            started.elapsed() < Duration::from_millis(500),
            "inherited-pipe grandchild blocked past timeout: {:?}",
            started.elapsed()
        );

        // 2. Concurrent stderr flood (> 64 KiB pipe capacity) + stdout payload completes cleanly without deadlock.
        let std_runner = StdOsKeychainProcessRunner::new();
        let flood = std_runner
            .run_piped(
                "/bin/sh",
                &[
                    "-c".to_owned(),
                    "dd if=/dev/zero bs=1024 count=96 >&2 2>/dev/null; printf 'concurrent_ok'"
                        .to_owned(),
                ],
                None,
            )
            .unwrap();
        assert_eq!(flood.status_code, Some(0));
        assert!(flood.stderr_has_bytes);
        assert_eq!(&*flood.stdout, b"concurrent_ok");

        // 3. Oversized stdout exceeding `MAX_KEYCHAIN_SECRET_BYTES + 16` triggers `SecretTooLarge` sentinel!
        let oversized = std_runner.run_piped(
            "/bin/sh",
            &[
                "-c".to_owned(),
                "dd if=/dev/zero bs=1024 count=8 2>/dev/null".to_owned(),
            ],
            None,
        );
        assert!(matches!(oversized, Err(KeychainError::SecretTooLarge)));
    }
}
