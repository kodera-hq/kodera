//! Per-service Compose user and environment variable allowlists for `deploy/community`.

use super::input_and_stack::validate_oidc_provider_origin;
use super::CommunityDeployError;

pub(super) fn is_admitted_service_user(service_name: &str, user_val: &str) -> bool {
    match service_name {
        "agent-state-init" | "media-socket-init" | "proximity-socket-init" => user_val == "0:0",
        "api-admission" | "media-storage-worker" => user_val == "10001:10001",
        _ => false,
    }
}

const API_ADMISSION_ADMITTED_ENV_KEYS: &[&str] = &["KODERA_TRUSTED_EDGE_ADDRESSES"];

const CADDY_ADMITTED_ENV_KEYS: &[&str] =
    &["KODERA_ACME_EMAIL", "KODERA_DOMAIN", "KODERA_MATRIX_DOMAIN"];

const DB_ADMITTED_ENV_KEYS: &[&str] = &["POSTGRES_DB", "POSTGRES_PASSWORD", "POSTGRES_USER"];

const LIVEKIT_ADMITTED_ENV_KEYS: &[&str] = &["LIVEKIT_KEYS"];

const MIGRATE_ADMITTED_ENV_KEYS: &[&str] = &[
    "DATABASE_URL",
    "DJANGO_ALLOWED_HOSTS",
    "DJANGO_SECRET_KEY",
    "KODERA_API_DATABASE_URL",
    "KODERA_AUTH_TRUST",
    "KODERA_BILLING_ENABLED",
    "KODERA_COLLAB_DATABASE_URL",
    "KODERA_CONSOLE_CLIENT_ID",
    "KODERA_CONTACT_SEAL_KEY",
    "KODERA_DEFAULT_COMMUNITY_ISSUER",
    "KODERA_DEFAULT_COMMUNITY_ORG_SLUG",
    "KODERA_DEFAULT_COMMUNITY_OWNER_USER_ID",
    "KODERA_DISCOVERY_HMAC_KEY",
    "KODERA_MEMBERSHIP_CURSOR_KEY",
    "KODERA_OUTBOX_SEAL_KEY",
    "KODERA_STAFF_ISSUER",
];

const ROOM_ACCESS_ADMITTED_ENV_KEYS: &[&str] = &[
    "LIVEKIT_API_KEY",
    "LIVEKIT_API_SECRET",
    "LIVEKIT_URL",
    "LIVEKIT_WS_URL",
    "ROOM_ACCESS_AGENT_USER",
    "ROOM_ACCESS_ALLOWED_ORIGINS",
    "ROOM_ACCESS_API_BIND",
    "ROOM_ACCESS_API_PORT",
    "ROOM_ACCESS_MATRIX_TOKEN",
    "ROOM_ACCESS_SYNAPSE_URL",
    "ROOM_ACCESS_WEBHOOK_BIND",
    "ROOM_ACCESS_WEBHOOK_PORT",
];

const SERVER_ADMITTED_ENV_KEYS: &[&str] = &[
    "DATABASE_URL",
    "DJANGO_ALLOWED_HOSTS",
    "DJANGO_SECRET_KEY",
    "KODERA_ANDROID_ASSETLINKS_SHA256",
    "KODERA_AUTH_TRUST",
    "KODERA_BILLING_ENABLED",
    "KODERA_COLLAB_ENGINE_URL",
    "KODERA_COLLAB_PUBLIC_URL",
    "KODERA_COLLAB_TICKET_KEY",
    "KODERA_CONSOLE_CLIENT_ID",
    "KODERA_CONSOLE_ORIGINS",
    "KODERA_CONTACT_SEAL_KEY",
    "KODERA_DEFAULT_COMMUNITY_ISSUER",
    "KODERA_DEFAULT_COMMUNITY_ORG_SLUG",
    "KODERA_DISCOVERY_HMAC_KEY",
    "KODERA_EDITION",
    "KODERA_IOS_APP_IDS",
    "KODERA_MEDIA_GATEWAY_SOCKET",
    "KODERA_MEDIA_ROOM_VERIFIER_URL",
    "KODERA_MEMBERSHIP_CURSOR_KEY",
    "KODERA_OUTBOX_SEAL_KEY",
    "KODERA_PROXIMITY_BROKER_SOCKET",
    "KODERA_STAFF_ISSUER",
    "KODERA_TRUSTED_EDGE_ADDRESSES",
];

const SYNAPSE_ADMITTED_ENV_KEYS: &[&str] = &[
    "KODERA_COMPOSE_TOPOLOGY",
    "KODERA_DEFAULT_COMMUNITY_ISSUER",
    "KODERA_DEFAULT_COMMUNITY_ORG_SLUG",
    "KODERA_FEDERATION_MODE",
    "KODERA_MATRIX_FEDERATION_ALLOWLIST",
    "KODERA_SYNAPSE_OIDC_CLIENT_SECRET",
    "KODERA_SYNAPSE_OIDC_ISSUER",
    "KODERA_TOPOLOGY",
    "PGPASSWORD",
    "PYTHONPATH",
    "SYNAPSE_REPORT_STATS",
    "SYNAPSE_SERVER_NAME",
];

const SYNAPSE_DB_ADMITTED_ENV_KEYS: &[&str] = &[
    "POSTGRES_DB",
    "POSTGRES_INITDB_ARGS",
    "POSTGRES_PASSWORD",
    "POSTGRES_USER",
];

const TENANT_AGENT_ADMITTED_ENV_KEYS: &[&str] = &[
    "KODERA_AGENT_STATE_DIR",
    "KODERA_AGENT_TOKEN",
    "KODERA_APPS",
    "KODERA_COMPOSE_PROJECT",
    "KODERA_CORE_URL",
    "KODERA_FEDERATION_MODE",
    "KODERA_MATRIX_FEDERATION_ALLOWLIST",
    "KODERA_MATRIX_PARTNER_CHANNELS",
    "KODERA_MATRIX_SERVER_NAME",
    "KODERA_ROOM_ACCESS_USER",
    "KODERA_SYNAPSE_TOKEN",
    "KODERA_SYNAPSE_URL",
    "LIVEKIT_API_KEY",
    "LIVEKIT_API_SECRET",
    "LIVEKIT_URL",
];

const WEB_ADMITTED_ENV_KEYS: &[&str] = &["KODERA_ATTACHMENT_BASE"];

const YJS_COLLAB_ADMITTED_ENV_KEYS: &[&str] = &[
    "DATABASE_URL",
    "KODERA_COLLAB_ALLOWED_ORIGINS",
    "KODERA_COLLAB_TICKET_KEY",
];

const fn slice_is_strictly_sorted_ascii(items: &[&str]) -> bool {
    let mut i = 1;
    while i < items.len() {
        let prev = items[i - 1].as_bytes();
        let curr = items[i].as_bytes();
        let mut k = 0;
        let min_len = if prev.len() < curr.len() {
            prev.len()
        } else {
            curr.len()
        };
        let mut decided = false;
        while k < min_len {
            if prev[k] < curr[k] {
                decided = true;
                break;
            }
            if prev[k] > curr[k] {
                return false;
            }
            k += 1;
        }
        if !decided && prev.len() >= curr.len() {
            return false;
        }
        i += 1;
    }
    true
}

const _: () = {
    assert!(slice_is_strictly_sorted_ascii(API_ADMISSION_ADMITTED_ENV_KEYS));
    assert!(slice_is_strictly_sorted_ascii(CADDY_ADMITTED_ENV_KEYS));
    assert!(slice_is_strictly_sorted_ascii(DB_ADMITTED_ENV_KEYS));
    assert!(slice_is_strictly_sorted_ascii(LIVEKIT_ADMITTED_ENV_KEYS));
    assert!(slice_is_strictly_sorted_ascii(MIGRATE_ADMITTED_ENV_KEYS));
    assert!(slice_is_strictly_sorted_ascii(
        ROOM_ACCESS_ADMITTED_ENV_KEYS
    ));
    assert!(slice_is_strictly_sorted_ascii(SERVER_ADMITTED_ENV_KEYS));
    assert!(slice_is_strictly_sorted_ascii(SYNAPSE_ADMITTED_ENV_KEYS));
    assert!(slice_is_strictly_sorted_ascii(SYNAPSE_DB_ADMITTED_ENV_KEYS));
    assert!(slice_is_strictly_sorted_ascii(
        TENANT_AGENT_ADMITTED_ENV_KEYS
    ));
    assert!(slice_is_strictly_sorted_ascii(WEB_ADMITTED_ENV_KEYS));
    assert!(slice_is_strictly_sorted_ascii(YJS_COLLAB_ADMITTED_ENV_KEYS));
};

/// Returns the sorted per-service allowlist of `environment:` variable names derived from
/// canonical `deploy/community/docker-compose.yml` (services without an `environment:` block
/// admit zero environment keys).
pub fn admitted_service_environment_keys(service_name: &str) -> &'static [&'static str] {
    match service_name {
        "api-admission" => API_ADMISSION_ADMITTED_ENV_KEYS,
        "caddy" => CADDY_ADMITTED_ENV_KEYS,
        "db" => DB_ADMITTED_ENV_KEYS,
        "livekit" => LIVEKIT_ADMITTED_ENV_KEYS,
        "migrate" => MIGRATE_ADMITTED_ENV_KEYS,
        "room-access" => ROOM_ACCESS_ADMITTED_ENV_KEYS,
        "server" => SERVER_ADMITTED_ENV_KEYS,
        "synapse" => SYNAPSE_ADMITTED_ENV_KEYS,
        "synapse-db" => SYNAPSE_DB_ADMITTED_ENV_KEYS,
        "tenant-agent" => TENANT_AGENT_ADMITTED_ENV_KEYS,
        "web" => WEB_ADMITTED_ENV_KEYS,
        "yjs-collab" => YJS_COLLAB_ADMITTED_ENV_KEYS,
        _ => &[],
    }
}

pub(super) fn is_admitted_service_env_var(
    service_name: &str,
    key: &str,
    val_opt: Option<&str>,
) -> bool {
    if admitted_service_environment_keys(service_name)
        .binary_search(&key)
        .is_err()
    {
        return false;
    }
    match key {
        "PYTHONPATH" => service_name == "synapse" && val_opt == Some("/tmp/kodera-policy"),
        "KODERA_BILLING_ENABLED" => {
            matches!(service_name, "migrate" | "server") && val_opt == Some("false")
        }
        "KODERA_EDITION" => service_name == "server" && val_opt == Some("community"),
        "KODERA_ATTACHMENT_BASE" => {
            service_name == "web"
                && match val_opt {
                    None | Some("" | "${KODERA_ATTACHMENT_BASE:-}") => true,
                    Some(v) => is_valid_https_attachment_base(v),
                }
        }
        _ => val_opt.is_none_or(|v| !v.contains('\0')),
    }
}

fn is_valid_https_attachment_base(raw: &str) -> bool {
    if !raw.starts_with("https://")
        || !raw.ends_with('/')
        || raw.chars().any(|c| {
            c.is_control()
                || c.is_whitespace()
                || matches!(c, '%' | '?' | '#' | '\\' | ';' | '\'' | '"' | '*')
        })
    {
        return false;
    }
    let Some(authority_end) = raw["https://".len()..]
        .find('/')
        .map(|idx| idx + "https://".len())
    else {
        return false;
    };
    let origin = &raw[..authority_end];
    let full_path = &raw[authority_end..];
    if validate_oidc_provider_origin(origin).is_err() || origin.contains('@') {
        return false;
    }
    full_path.len() >= 3
        && full_path.starts_with('/')
        && full_path.ends_with('/')
        && !full_path.contains("//")
        && !full_path[1..full_path.len() - 1]
            .split('/')
            .any(|seg| seg.is_empty() || matches!(seg, "." | ".."))
}

pub(super) fn validate_resolved_service_environment(
    service_name: &str,
    val: &serde_json::Value,
) -> Result<(), CommunityDeployError> {
    if val.is_null() {
        return Ok(());
    }
    if let Some(env_obj) = val.as_object() {
        for (k, v) in env_obj {
            let v_str = match v {
                serde_json::Value::Null => None,
                serde_json::Value::String(s) => Some(s.as_str()),
                _ => return Err(CommunityDeployError::ComposeConfigInvalid),
            };
            if !is_admitted_service_env_var(service_name, k, v_str) {
                return Err(CommunityDeployError::ComposeConfigInvalid);
            }
        }
        return Ok(());
    }
    if let Some(env_arr) = val.as_array() {
        for item in env_arr {
            let Some(raw_pair) = item.as_str() else {
                return Err(CommunityDeployError::ComposeConfigInvalid);
            };
            let (k, v_opt) = match raw_pair.split_once('=') {
                Some((k, v)) => (k, Some(v)),
                None => (raw_pair, None),
            };
            if !is_admitted_service_env_var(service_name, k, v_opt) {
                return Err(CommunityDeployError::ComposeConfigInvalid);
            }
        }
        return Ok(());
    }
    Err(CommunityDeployError::ComposeConfigInvalid)
}
