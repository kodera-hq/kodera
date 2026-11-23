//! Resolved `docker compose config --format json` structural and security policy validator.

use super::compose_env::{is_admitted_service_user, validate_resolved_service_environment};
use super::compose_service_policy::{
    ensure_api_admission_hardening, is_admitted_named_volume_source, is_admitted_service_image,
    validate_compose_volume_entry, validate_resolved_bind_source, validate_resolved_service_build,
    validate_resolved_service_command, validate_resolved_service_entrypoint,
    validate_resolved_service_ports, verify_kodera_source_root, API_ADMISSION_ONLY_NETWORK,
    API_ADMISSION_SERVICE_NAME,
};
use super::compose_yaml::{is_admitted_cap_add_token, is_admitted_cap_drop_token};
use super::input_and_stack::is_sensitive_stack_root;
use super::{
    CommunityDeployError, ADMITTED_COMMUNITY_COMPOSE_SERVICES, ADMITTED_COMPOSE_SERVICE_DIRECTIVES,
    MAX_COMPOSE_FILE_BYTES,
};
use std::path::{Component, Path, PathBuf};

/// Validates the resolved JSON configuration emitted by `docker compose ... config --format json`,
/// eliminating YAML indentation, merge-key (`<<:`), anchor/alias, build-context, and volume bypasses.
pub fn validate_resolved_compose_config_json(
    raw_json: &str,
    canonical_stack_dir: &Path,
) -> Result<(), CommunityDeployError> {
    validate_resolved_compose_config_json_with_source(raw_json, canonical_stack_dir, None)
}

/// Validates the resolved JSON configuration emitted by `docker compose ... config --format json`
/// against `canonical_stack_dir` and an optional operator-configured `KODERA_SOURCE_DIR` root.
pub fn validate_resolved_compose_config_json_with_source(
    raw_json: &str,
    canonical_stack_dir: &Path,
    configured_source_root: Option<&Path>,
) -> Result<(), CommunityDeployError> {
    if !canonical_stack_dir.is_absolute()
        || canonical_stack_dir
            .components()
            .any(|comp| matches!(comp, Component::ParentDir))
        || is_sensitive_stack_root(canonical_stack_dir)
    {
        return Err(CommunityDeployError::ComposeConfigInvalid);
    }
    if raw_json.trim().is_empty() || raw_json.len() > (MAX_COMPOSE_FILE_BYTES as usize) * 4 {
        return Err(CommunityDeployError::ComposeConfigInvalid);
    }

    let mut verified_source_root: Option<PathBuf> = match configured_source_root {
        Some(raw_root) => Some(verify_kodera_source_root(raw_root)?),
        None => None,
    };

    let parsed: serde_json::Value =
        serde_json::from_str(raw_json).map_err(|_| CommunityDeployError::ComposeConfigInvalid)?;
    let Some(root) = parsed.as_object() else {
        return Err(CommunityDeployError::ComposeConfigInvalid);
    };

    for root_key in root.keys() {
        if !matches!(
            root_key.as_str(),
            "name" | "services" | "volumes" | "networks"
        ) {
            return Err(CommunityDeployError::ComposeConfigInvalid);
        }
    }

    let Some(services) = root.get("services").and_then(serde_json::Value::as_object) else {
        return Err(CommunityDeployError::ComposeConfigInvalid);
    };
    if services.is_empty() {
        return Err(CommunityDeployError::ComposeConfigInvalid);
    }

    for (svc_name, svc_val) in services {
        if ADMITTED_COMMUNITY_COMPOSE_SERVICES
            .binary_search(&svc_name.as_str())
            .is_err()
        {
            return Err(CommunityDeployError::ComposeConfigInvalid);
        }
        let Some(svc_obj) = svc_val.as_object() else {
            return Err(CommunityDeployError::ComposeConfigInvalid);
        };
        let has_build = svc_obj.get("build").is_some_and(|v| !v.is_null());
        let has_image = svc_obj
            .get("image")
            .and_then(serde_json::Value::as_str)
            .is_some();
        if !has_build && !has_image {
            return Err(CommunityDeployError::ComposeConfigInvalid);
        }
        let is_api_admission = svc_name.as_str() == API_ADMISSION_SERVICE_NAME;
        let mut api_read_only_true = false;
        let mut api_cap_drop_all = false;
        let mut api_security_opt_no_new_privileges = false;
        let mut api_networks: Vec<String> = Vec::new();
        let mut api_volumes_nonempty = false;
        for (directive, val) in svc_obj {
            if ADMITTED_COMPOSE_SERVICE_DIRECTIVES
                .binary_search(&directive.as_str())
                .is_err()
            {
                return Err(CommunityDeployError::ComposeConfigInvalid);
            }
            match directive.as_str() {
                "build" => {
                    validate_resolved_service_build(
                        svc_name,
                        val,
                        canonical_stack_dir,
                        &mut verified_source_root,
                    )?;
                }
                "image" => {
                    if !val.is_null() {
                        let Some(img_str) = val.as_str() else {
                            return Err(CommunityDeployError::ComposeConfigInvalid);
                        };
                        if !is_admitted_service_image(svc_name, img_str) {
                            return Err(CommunityDeployError::ComposeConfigInvalid);
                        }
                    }
                }
                "entrypoint" => {
                    validate_resolved_service_entrypoint(svc_name, val)?;
                }
                "command" => {
                    validate_resolved_service_command(svc_name, val)?;
                }
                "environment" => {
                    validate_resolved_service_environment(svc_name, val)?;
                }
                "user" => {
                    if !val.is_null() {
                        let Some(u_str) = val.as_str() else {
                            return Err(CommunityDeployError::ComposeConfigInvalid);
                        };
                        if !is_admitted_service_user(svc_name, u_str) {
                            return Err(CommunityDeployError::ComposeConfigInvalid);
                        }
                    }
                }
                "ports" => {
                    if !val.is_null() {
                        validate_resolved_service_ports(svc_name, val)?;
                    }
                }
                "cap_add" => {
                    let Some(caps) = val.as_array() else {
                        return Err(CommunityDeployError::ComposeConfigInvalid);
                    };
                    for cap in caps {
                        let Some(cap_str) = cap.as_str() else {
                            return Err(CommunityDeployError::ComposeConfigInvalid);
                        };
                        if !is_admitted_cap_add_token(cap_str) {
                            return Err(CommunityDeployError::ComposeConfigInvalid);
                        }
                    }
                }
                "cap_drop" => {
                    let Some(caps) = val.as_array() else {
                        return Err(CommunityDeployError::ComposeConfigInvalid);
                    };
                    for cap in caps {
                        let Some(cap_str) = cap.as_str() else {
                            return Err(CommunityDeployError::ComposeConfigInvalid);
                        };
                        if !is_admitted_cap_drop_token(cap_str) {
                            return Err(CommunityDeployError::ComposeConfigInvalid);
                        }
                    }
                    if is_api_admission && !caps.is_empty() {
                        api_cap_drop_all = true;
                    }
                }
                "security_opt" => {
                    let Some(opts) = val.as_array() else {
                        return Err(CommunityDeployError::ComposeConfigInvalid);
                    };
                    for opt in opts {
                        if opt.as_str() != Some("no-new-privileges:true") {
                            return Err(CommunityDeployError::ComposeConfigInvalid);
                        }
                    }
                    if is_api_admission && !opts.is_empty() {
                        api_security_opt_no_new_privileges = true;
                    }
                }
                "read_only" => {
                    if is_api_admission {
                        if val != &serde_json::Value::Bool(true) {
                            return Err(CommunityDeployError::ComposeConfigInvalid);
                        }
                        api_read_only_true = true;
                    }
                }
                "networks" => {
                    if is_api_admission {
                        let Some(nets) = val.as_object() else {
                            return Err(CommunityDeployError::ComposeConfigInvalid);
                        };
                        for (net_name, net_cfg) in nets {
                            if net_name != API_ADMISSION_ONLY_NETWORK {
                                return Err(CommunityDeployError::ComposeConfigInvalid);
                            }
                            if !net_cfg.is_null() {
                                let Some(net_obj) = net_cfg.as_object() else {
                                    return Err(CommunityDeployError::ComposeConfigInvalid);
                                };
                                for net_key in net_obj.keys() {
                                    if net_key != "ipv4_address" {
                                        return Err(CommunityDeployError::ComposeConfigInvalid);
                                    }
                                }
                                if let Some(ip_val) = net_obj.get("ipv4_address") {
                                    if ip_val.as_str().is_none_or(str::is_empty) {
                                        return Err(CommunityDeployError::ComposeConfigInvalid);
                                    }
                                }
                            }
                            api_networks.push(net_name.clone());
                        }
                    }
                }
                "volumes" => {
                    let Some(vols) = val.as_array() else {
                        return Err(CommunityDeployError::ComposeConfigInvalid);
                    };
                    if is_api_admission && !vols.is_empty() {
                        api_volumes_nonempty = true;
                    }
                    for entry in vols {
                        if let Some(short_spec) = entry.as_str() {
                            if short_spec.contains("${") {
                                return Err(CommunityDeployError::ComposeConfigInvalid);
                            }
                            validate_compose_volume_entry(short_spec)?;
                        } else if let Some(vobj) = entry.as_object() {
                            for vk in vobj.keys() {
                                if !matches!(
                                    vk.as_str(),
                                    "type"
                                        | "source"
                                        | "target"
                                        | "read_only"
                                        | "bind"
                                        | "volume"
                                        | "consistency"
                                ) {
                                    return Err(CommunityDeployError::ComposeConfigInvalid);
                                }
                            }
                            let Some(vtype) = vobj.get("type").and_then(serde_json::Value::as_str)
                            else {
                                return Err(CommunityDeployError::ComposeConfigInvalid);
                            };
                            let Some(source) =
                                vobj.get("source").and_then(serde_json::Value::as_str)
                            else {
                                return Err(CommunityDeployError::ComposeConfigInvalid);
                            };
                            let Some(target) =
                                vobj.get("target").and_then(serde_json::Value::as_str)
                            else {
                                return Err(CommunityDeployError::ComposeConfigInvalid);
                            };
                            if !target.starts_with('/')
                                || target == "/"
                                || target.to_ascii_lowercase().contains("docker.sock")
                            {
                                return Err(CommunityDeployError::ComposeConfigInvalid);
                            }
                            match vtype {
                                "volume" => {
                                    if source.contains("${")
                                        || !is_admitted_named_volume_source(source)
                                    {
                                        return Err(CommunityDeployError::ComposeConfigInvalid);
                                    }
                                    if let Some(sub) = vobj
                                        .get("volume")
                                        .and_then(serde_json::Value::as_object)
                                        .and_then(|m| m.get("subpath"))
                                        .and_then(serde_json::Value::as_str)
                                    {
                                        if sub.contains("..") || sub.starts_with('/') {
                                            return Err(CommunityDeployError::ComposeConfigInvalid);
                                        }
                                    }
                                }
                                "bind" => {
                                    if vobj.get("read_only") != Some(&serde_json::Value::Bool(true))
                                    {
                                        return Err(CommunityDeployError::ComposeConfigInvalid);
                                    }
                                    if let Some(bind_opts) =
                                        vobj.get("bind").and_then(serde_json::Value::as_object)
                                    {
                                        if let Some(prop) = bind_opts
                                            .get("propagation")
                                            .and_then(serde_json::Value::as_str)
                                        {
                                            if !matches!(prop, "rprivate" | "private") {
                                                return Err(
                                                    CommunityDeployError::ComposeConfigInvalid,
                                                );
                                            }
                                        }
                                    }
                                    validate_resolved_bind_source(
                                        source,
                                        canonical_stack_dir,
                                        &mut verified_source_root,
                                    )?;
                                }
                                _ => return Err(CommunityDeployError::ComposeConfigInvalid),
                            }
                        } else {
                            return Err(CommunityDeployError::ComposeConfigInvalid);
                        }
                    }
                }
                _ => {}
            }
        }
        if is_api_admission {
            ensure_api_admission_hardening(
                api_read_only_true,
                api_cap_drop_all,
                api_security_opt_no_new_privileges,
                &api_networks,
                api_volumes_nonempty,
            )?;
        }
    }

    if let Some(top_vols_val) = root.get("volumes") {
        if !top_vols_val.is_null() {
            let Some(top_vols) = top_vols_val.as_object() else {
                return Err(CommunityDeployError::ComposeConfigInvalid);
            };
            for (vol_name, vol_cfg) in top_vols {
                if !is_admitted_named_volume_source(vol_name) {
                    return Err(CommunityDeployError::ComposeConfigInvalid);
                }
                if !vol_cfg.is_null() {
                    let Some(vobj) = vol_cfg.as_object() else {
                        return Err(CommunityDeployError::ComposeConfigInvalid);
                    };
                    if let Some(ext) = vobj.get("external") {
                        if ext != &serde_json::Value::Bool(false) {
                            return Err(CommunityDeployError::ComposeConfigInvalid);
                        }
                    }
                    if let Some(driver) = vobj.get("driver") {
                        if driver.as_str() != Some("local") {
                            return Err(CommunityDeployError::ComposeConfigInvalid);
                        }
                    }
                    if let Some(driver_opts) = vobj.get("driver_opts") {
                        if !driver_opts.is_null()
                            && driver_opts.as_object().is_none_or(|m| !m.is_empty())
                        {
                            return Err(CommunityDeployError::ComposeConfigInvalid);
                        }
                    }
                }
            }
        }
    }

    if let Some(top_nets_val) = root.get("networks") {
        if !top_nets_val.is_null() {
            let Some(top_nets) = top_nets_val.as_object() else {
                return Err(CommunityDeployError::ComposeConfigInvalid);
            };
            for (_net_name, net_cfg) in top_nets {
                if !net_cfg.is_null() {
                    let Some(nobj) = net_cfg.as_object() else {
                        return Err(CommunityDeployError::ComposeConfigInvalid);
                    };
                    if let Some(ext) = nobj.get("external") {
                        if ext != &serde_json::Value::Bool(false) {
                            return Err(CommunityDeployError::ComposeConfigInvalid);
                        }
                    }
                    if let Some(driver) = nobj.get("driver").and_then(serde_json::Value::as_str) {
                        if !matches!(driver, "bridge" | "default" | "") {
                            return Err(CommunityDeployError::ComposeConfigInvalid);
                        }
                    }
                }
            }
        }
    }

    Ok(())
}
