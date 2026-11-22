pub(super) use super::compose_service_policy::CANONICAL_SYNAPSE_ENTRYPOINT_SCRIPT;
pub(super) use super::compose_yaml::{is_admitted_cap_add_token, validate_compose_file_policy};
pub(super) use super::dotenv::{
    create_dotenv_candidate_0600, encode_base64_padded_32, encode_base64url_padded_32,
    publish_candidate_dotenv_no_replace,
};
pub(super) use super::input_and_stack::{derive_matrix_base_domain, is_sensitive_stack_root};
use super::*;
pub(super) use crate::self_host_health::{
    DockerUnavailableReason, SelfHostHealthError, ServiceReadiness,
};
pub(super) use std::collections::{BTreeMap, BTreeSet, VecDeque};
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Mutex;
use std::time::Duration;

mod compose_policy;
mod deploy_and_dotenv;
mod preflight_and_prepare;

pub(crate) fn non_shared_test_scratch_root() -> PathBuf {
    let sys_tmp = std::env::temp_dir();
    if let Ok(canonical_tmp) = fs::canonicalize(&sys_tmp) {
        if !is_sensitive_stack_root(&canonical_tmp) {
            return sys_tmp;
        }
    }
    let base = std::env::var_os("XDG_CACHE_HOME")
        .map(PathBuf::from)
        .filter(|p| p.is_absolute() && !is_sensitive_stack_root(p))
        .or_else(|| {
            std::env::var_os("HOME")
                .or_else(|| std::env::var_os("USERPROFILE"))
                .map(|h| PathBuf::from(h).join(".cache"))
        })
        .unwrap_or_else(|| Path::new(env!("CARGO_MANIFEST_DIR")).join("../../.cache"));
    let root = base.join("kodera-desktop-test-scratch");
    let _ = fs::create_dir_all(&root);
    root
}

static TEST_DIR_SEQ: AtomicU64 = AtomicU64::new(1);

pub(super) struct TempStackFixture {
    pub(super) dir: PathBuf,
}

impl TempStackFixture {
    pub(super) fn new_with_compose() -> Self {
        let seq = TEST_DIR_SEQ.fetch_add(1, Ordering::Relaxed);
        let dir = non_shared_test_scratch_root().join(format!(
            "kodera-community-deploy-test-{}-{seq}",
            std::process::id()
        ));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        fs::write(
                dir.join("docker-compose.yml"),
                "services:\n  db:\n    image: postgres:17.12-alpine@sha256:a77aa70e641402a21411b92b721c58d10f23b50ae5fdd2333efd22d166e1e5f7\n",
            )
            .unwrap();
        Self { dir }
    }

    pub(super) fn path_str(&self) -> String {
        self.dir.to_str().unwrap().to_owned()
    }
}

impl Drop for TempStackFixture {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.dir);
    }
}

type RecordedCall = (String, Vec<String>);

pub(super) struct MockDockerRunner {
    calls: Mutex<Vec<RecordedCall>>,
    responses: Mutex<VecDeque<Result<CommandExecOutput, DockerUnavailableReason>>>,
}

impl MockDockerRunner {
    pub(super) fn with_responses(
        items: impl IntoIterator<Item = Result<CommandExecOutput, DockerUnavailableReason>>,
    ) -> Self {
        Self {
            calls: Mutex::new(Vec::new()),
            responses: Mutex::new(items.into_iter().collect()),
        }
    }

    pub(super) fn ok_stdout(stdout: &str) -> Result<CommandExecOutput, DockerUnavailableReason> {
        Ok(CommandExecOutput {
            status_code: Some(0),
            stdout: stdout.to_owned(),
            stderr: String::new(),
            timed_out: false,
        })
    }

    pub(super) fn ok_compose_json() -> Result<CommandExecOutput, DockerUnavailableReason> {
        Self::ok_stdout(
            r#"{"name":"community","services":{"db":{"image":"postgres:17.12-alpine@sha256:a77aa70e641402a21411b92b721c58d10f23b50ae5fdd2333efd22d166e1e5f7"}}}"#,
        )
    }

    pub(super) fn fail_stderr(
        code: i32,
        stderr: &str,
    ) -> Result<CommandExecOutput, DockerUnavailableReason> {
        Ok(CommandExecOutput {
            status_code: Some(code),
            stdout: String::new(),
            stderr: stderr.to_owned(),
            timed_out: false,
        })
    }

    pub(super) fn recorded_calls(&self) -> Vec<RecordedCall> {
        self.calls.lock().unwrap().clone()
    }
}

impl CommunityCommandRunner for MockDockerRunner {
    fn run_argv(
        &self,
        program: &str,
        args: &[String],
        _working_dir: Option<&Path>,
        _timeout: Duration,
    ) -> Result<CommandExecOutput, DockerUnavailableReason> {
        self.calls
            .lock()
            .unwrap()
            .push((program.to_owned(), args.to_vec()));
        self.responses
            .lock()
            .unwrap()
            .pop_front()
            .unwrap_or_else(|| Self::ok_stdout(""))
    }

    fn poll_backoff(&self) -> Duration {
        Duration::ZERO
    }
}

pub(super) fn healthy_full_stack_ps_json() -> &'static str {
    r#"[
            {"Service":"keycloak","State":"running","Health":"healthy","MemoryMiB":256},
            {"Service":"db","State":"running","Health":"healthy","MemoryMiB":192},
            {"Service":"synapse","State":"running","Health":"healthy","KoderaPolicy":"0.1.4","MemoryMiB":420},
            {"Service":"server","State":"running","Health":"healthy","MemoryMiB":220},
            {"Service":"web","State":"running","Health":"healthy","MemoryMiB":64},
            {"Service":"livekit","State":"running","Health":"healthy","MemoryMiB":128}
        ]"#
}
