pub(super) use super::*;
pub(super) use crate::{
    CloudProvider, CommunityPreflightSpec, CommunityPrepareSpec, CommunityTlsMode,
    DeployValidationError, DesktopNotificationRequest, DesktopWorkspaceSession, KeychainSecretKind,
    TrayCallKind, TrayMenuItemId,
};
pub(super) use kodera_rs::{
    encode_hex, hmac_sha256, CoreError, CoreThemeMode, DeviceIdentitySigner, Ed25519PublicKey,
    Ed25519Signature, SafetyStatus, SignatureVerifier, SoundPackId, UuidV7,
};
use std::collections::HashSet;

mod audit_routes;
mod core_and_parser;
mod polls_and_preferences;
mod shell_and_wizard;

const ORG: &str = "019a5e62-6ca0-7303-8303-030303030303";
const OTHER_ORG: &str = "019a5e62-6ca0-7303-8303-030303030304";
const TOKEN: &str = "fixture-token-never-reflect";

struct Signer(u8);
impl DeviceIdentitySigner for Signer {
    fn public_key(&self) -> Ed25519PublicKey {
        [self.0; 32]
    }
    fn sign(&self, message: &[u8]) -> Result<Ed25519Signature, CoreError> {
        let digest = hmac_sha256(&[self.0; 32], message);
        let mut signature = [0; 64];
        signature[..32].copy_from_slice(&digest);
        signature[32..].copy_from_slice(&digest);
        Ok(signature)
    }
}
impl SignatureVerifier for Signer {
    fn verify(
        &self,
        public_key: &Ed25519PublicKey,
        message: &[u8],
        signature: &Ed25519Signature,
    ) -> Result<(), CoreError> {
        if public_key != &self.public_key() || signature != &self.sign(message)? {
            return Err(CoreError::InvalidSignature);
        }
        Ok(())
    }
}

fn session() -> DesktopWorkspaceSession {
    DesktopWorkspaceSession::new(ORG, [0x42; 32], HashSet::from([[1; 32], [2; 32]]), 128).unwrap()
}
fn plan_request(org: &str, token: &str) -> DesktopCommandRequest {
    DesktopCommandRequest::PlanSelfHost {
        organisation_id: org.to_owned(),
        provider: CloudProvider::Scaleway,
        region: "fr-par-1".to_owned(),
        fqdn: "chat.example.org".to_owned(),
        acme_email: "ops@example.org".to_owned(),
        token: RedactedApiToken::new(token).unwrap(),
    }
}
fn populate(session: &mut DesktopWorkspaceSession, sender: u8, time: u64) {
    let signer = Signer(sender);
    session
        .create_local_checkin(
            ORG,
            UuidV7::from_parts(time, [sender; 10]),
            SafetyStatus::Safe,
            "Local fixture",
            &signer,
            &signer,
        )
        .unwrap();
}

fn json(command: &str, fields: &str) -> String {
    format!(r#"{{"command":"{command}","organisation_id":"{ORG}"{fields}}}"#)
}

fn poll_request(command: &str, fields: &str) -> String {
    json(
        command,
        &format!(r#", "channel_id":"text", "poll_id":"poll"{fields}"#),
    )
}
fn create_poll_json() -> String {
    poll_request(
        "create_channel_poll",
        r#", "question":"Choose?", "options":["One","Two"],"allow_multiple":true"#,
    )
}

fn profile_json() -> String {
    json(
        "update_user_profile",
        &format!(
            r#", "user_id":"{ORG}","display_name":"Member","handle":"member","role_title":"Reviewer","presence":"online","rank":"member""#
        ),
    )
}
fn save_json(pad: &str, channel: &str, body: &str) -> String {
    json(
        "save_docs_pad",
        &format!(
            r#", "pad_id":"{pad}","channel_id":"{channel}","title":"Title","markdown_body":"{body}","actor":"local-author""#
        ),
    )
}

struct AuditMockCommunityRunner;

impl crate::CommunityCommandRunner for AuditMockCommunityRunner {
    fn run_argv(
        &self,
        program: &str,
        args: &[String],
        _working_dir: Option<&std::path::Path>,
        _timeout: std::time::Duration,
    ) -> Result<crate::CommandExecOutput, crate::DockerUnavailableReason> {
        assert_eq!(program, "docker");
        let stdout = if args == ["--version"] {
            "Docker version 28.1.0, build 4d8c241\n"
        } else if args == ["compose", "version"] {
            "Docker Compose version v2.36.0\n"
        } else if args.ends_with(&[
            "config".to_owned(),
            "--format".to_owned(),
            "json".to_owned(),
        ]) {
            r#"{"name":"community","services":{"db":{"image":"postgres:17.12-alpine@sha256:a77aa70e641402a21411b92b721c58d10f23b50ae5fdd2333efd22d166e1e5f7"}}}"#
        } else if args.ends_with(&["ps".to_owned(), "--format".to_owned(), "json".to_owned()]) {
            r#"[{"Service":"keycloak","State":"running","Health":"healthy","MemoryMiB":256},{"Service":"db","State":"running","Health":"healthy","MemoryMiB":192},{"Service":"synapse","State":"running","Health":"healthy","KoderaPolicy":"0.1.4","MemoryMiB":420},{"Service":"server","State":"running","Health":"healthy","MemoryMiB":220},{"Service":"web","State":"running","Health":"healthy","MemoryMiB":64},{"Service":"livekit","State":"running","Health":"healthy","MemoryMiB":128}]"#
        } else {
            ""
        };
        Ok(crate::CommandExecOutput {
            status_code: Some(0),
            stdout: stdout.to_owned(),
            stderr: String::new(),
            timed_out: false,
        })
    }

    fn poll_backoff(&self) -> std::time::Duration {
        std::time::Duration::ZERO
    }
}

fn fresh_audit_community_stack_dir(tag: &str) -> std::path::PathBuf {
    static SEQ: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(1);
    let id = SEQ.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
    let raw_dir = crate::self_host_deploy::non_shared_test_scratch_root().join(format!(
        "kodera-desktop-audit-{tag}-{}-{id}",
        std::process::id()
    ));
    let _ = std::fs::remove_dir_all(&raw_dir);
    std::fs::create_dir_all(&raw_dir).unwrap();
    let canonical = std::fs::canonicalize(&raw_dir).unwrap();
    std::fs::write(
            canonical.join("docker-compose.yml"),
            "services:\n  db:\n    image: postgres:17.12-alpine@sha256:a77aa70e641402a21411b92b721c58d10f23b50ae5fdd2333efd22d166e1e5f7\n",
        )
        .unwrap();
    canonical
}

fn audit_community_stack_dir() -> &'static str {
    static STACK_DIR: std::sync::OnceLock<String> = std::sync::OnceLock::new();
    STACK_DIR
            .get_or_init(|| {
                let raw_dir = crate::self_host_deploy::non_shared_test_scratch_root().join(
                    format!("kodera-desktop-audit-community-{}", std::process::id()),
                );
                std::fs::create_dir_all(&raw_dir).unwrap();
                let canonical = std::fs::canonicalize(&raw_dir).unwrap();
                std::fs::write(
                    canonical.join("docker-compose.yml"),
                    "services:\n  db:\n    image: postgres:17.12-alpine@sha256:a77aa70e641402a21411b92b721c58d10f23b50ae5fdd2333efd22d166e1e5f7\n",
                )
                .unwrap();
                let env_path = canonical.join(".env");
                std::fs::write(
                    &env_path,
                    "KODERA_OIDC_PROVIDER_ORIGIN=https://id.example.org\n",
                )
                .unwrap();
                #[cfg(unix)]
                {
                    use std::os::unix::fs::PermissionsExt;
                    std::fs::set_permissions(&env_path, std::fs::Permissions::from_mode(0o600))
                        .unwrap();
                }
                canonical.to_str().unwrap().to_owned()
            })
            .as_str()
}

fn audit_workspace() -> DesktopWorkspaceSession {
    let mut state = session();
    populate(&mut state, 1, 1);
    state
        .configure_docs_host(ORG, Some("docs.example.org"))
        .unwrap();
    state
        .configure_community_runner(ORG, std::sync::Arc::new(AuditMockCommunityRunner))
        .unwrap();
    state
        .create_channel_poll(
            ORG,
            "text",
            "poll",
            "Choose?",
            &["One".into(), "Two".into()],
            true,
        )
        .unwrap();
    assert!(matches!(
        state.dispatch_command(&profile_json()),
        DesktopCommandResponse::UserProfile(_)
    ));
    state
        .save_docs_pad(ORG, "pad", "text", "Title", "body", "local-author")
        .unwrap();
    state
        .configure_ptt(ORG, true, Some("Ctrl+Shift+Space"))
        .unwrap();
    state
        .configure_keychain_backend(
            ORG,
            std::sync::Arc::new(crate::EphemeralKeychainBackend::with_clock(
                std::sync::Arc::new(|| 1_762_520_100),
            )),
        )
        .unwrap();
    state
        .store_keychain_credential(
            ORG,
            KeychainSecretKind::OidcRefresh,
            "@member:community.kodera.io",
            "DEV_01",
            1_762_520_000,
            Some(1_762_523_600),
            TOKEN,
        )
        .unwrap();
    state
        .begin_oidc_pkce_loopback(
            ORG,
            "https://auth.kodera.io/realms/kodera",
            "kodera-desktop",
            "pkce_verifier_fixture_alpha_bravo_charlie_delta_01",
            "audit_pkce_state_fixture_01",
            49_152,
        )
        .unwrap();
    state
}
