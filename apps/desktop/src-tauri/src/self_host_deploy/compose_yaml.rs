//! Pre-execution raw `docker-compose.yml` policy scanner blocking anchors, merge keys, and privilege directives.

use super::compose_env::{
    admitted_service_environment_keys, is_admitted_service_env_var, is_admitted_service_user,
};
use super::compose_service_policy::{
    expected_service_build_spec, is_admitted_named_volume_source, is_admitted_service_image,
    is_admitted_vite_build_arg_key, is_admitted_yaml_build_context,
    matches_canonical_synapse_entrypoint_script, matches_canonical_web_entrypoint_script,
    validate_compose_volume_entry, validate_service_command_argv, validate_yaml_port_entry,
};
use super::{
    CommunityDeployError, ADMITTED_COMMUNITY_COMPOSE_SERVICES, ADMITTED_COMPOSE_SERVICE_DIRECTIVES,
    FORBIDDEN_PRIVILEGED_COMPOSE_DIRECTIVES, MAX_COMPOSE_FILE_BYTES,
};
use std::fs;
use std::path::Path;

fn strip_inline_yaml_comment(raw: &str) -> &str {
    let bytes = raw.as_bytes();
    let mut in_single = false;
    let mut in_double = false;
    let mut escaped = false;
    for (idx, &b) in bytes.iter().enumerate() {
        if in_double {
            if escaped {
                escaped = false;
            } else if b == b'\\' {
                escaped = true;
            } else if b == b'"' {
                in_double = false;
            }
            continue;
        }
        if in_single {
            if b == b'\'' {
                in_single = false;
            }
            continue;
        }
        match b {
            b'"' => in_double = true,
            b'\'' => in_single = true,
            b'#' if idx == 0 || bytes[idx - 1].is_ascii_whitespace() => {
                return &raw[..idx];
            }
            _ => {}
        }
    }
    raw
}

fn contains_unquoted_yaml_anchor_or_alias(uncommented: &str) -> bool {
    let bytes = uncommented.as_bytes();
    let mut in_single = false;
    let mut in_double = false;
    let mut escaped = false;
    for (idx, &b) in bytes.iter().enumerate() {
        if in_double {
            if escaped {
                escaped = false;
            } else if b == b'\\' {
                escaped = true;
            } else if b == b'"' {
                in_double = false;
            }
            continue;
        }
        if in_single {
            if b == b'\'' {
                in_single = false;
            }
            continue;
        }
        match b {
            b'"' => in_double = true,
            b'\'' => in_single = true,
            b'&' | b'*' => {
                let prev_boundary =
                    idx == 0 || matches!(bytes[idx - 1], b' ' | b':' | b'[' | b',' | b'-');
                if prev_boundary {
                    return true;
                }
            }
            _ => {}
        }
    }
    false
}

pub(super) fn is_admitted_cap_add_token(raw: &str) -> bool {
    let trimmed = raw.trim().trim_matches(|c| matches!(c, '"' | '\''));
    let normalized = trimmed.to_ascii_uppercase();
    let cap = normalized.strip_prefix("CAP_").unwrap_or(&normalized);
    matches!(cap, "CHOWN" | "FOWNER" | "DAC_OVERRIDE")
}

pub(super) fn is_admitted_cap_drop_token(raw: &str) -> bool {
    let trimmed = raw.trim().trim_matches(|c| matches!(c, '"' | '\''));
    let normalized = trimmed.to_ascii_uppercase();
    let cap = normalized.strip_prefix("CAP_").unwrap_or(&normalized);
    cap == "ALL"
}

fn validate_inline_cap_add_list(rest: &str) -> Result<(), CommunityDeployError> {
    let Some(inner) = rest.strip_prefix('[').and_then(|s| s.strip_suffix(']')) else {
        return Err(CommunityDeployError::ComposeConfigInvalid);
    };
    if inner.trim().is_empty() {
        return Ok(());
    }
    for token in inner.split(',') {
        if !is_admitted_cap_add_token(token) {
            return Err(CommunityDeployError::ComposeConfigInvalid);
        }
    }
    Ok(())
}

fn validate_inline_cap_drop_list(rest: &str) -> Result<(), CommunityDeployError> {
    let Some(inner) = rest.strip_prefix('[').and_then(|s| s.strip_suffix(']')) else {
        return Err(CommunityDeployError::ComposeConfigInvalid);
    };
    if inner.trim().is_empty() {
        return Ok(());
    }
    for token in inner.split(',') {
        if !is_admitted_cap_drop_token(token) {
            return Err(CommunityDeployError::ComposeConfigInvalid);
        }
    }
    Ok(())
}

fn validate_inline_security_opt_list(rest: &str) -> Result<(), CommunityDeployError> {
    let Some(inner) = rest.strip_prefix('[').and_then(|s| s.strip_suffix(']')) else {
        return Err(CommunityDeployError::ComposeConfigInvalid);
    };
    if inner.trim().is_empty() {
        return Ok(());
    }
    for token in inner.split(',') {
        let opt = token.trim().trim_matches(|c| matches!(c, '"' | '\''));
        if opt != "no-new-privileges:true" {
            return Err(CommunityDeployError::ComposeConfigInvalid);
        }
    }
    Ok(())
}

pub(super) fn unquote_yaml_scalar(raw: &str) -> Result<&str, CommunityDeployError> {
    let trimmed = raw.trim();
    if trimmed.starts_with('{')
        || trimmed.starts_with('[')
        || trimmed.starts_with('|')
        || trimmed.starts_with('>')
        || trimmed.chars().any(char::is_control)
    {
        return Err(CommunityDeployError::ComposeConfigInvalid);
    }
    if trimmed.starts_with('"') {
        let Some(inner) = trimmed.strip_prefix('"').and_then(|s| s.strip_suffix('"')) else {
            return Err(CommunityDeployError::ComposeConfigInvalid);
        };
        if inner.contains('"') || inner.contains('\\') {
            return Err(CommunityDeployError::ComposeConfigInvalid);
        }
        return Ok(inner);
    }
    if trimmed.starts_with('\'') {
        let Some(inner) = trimmed
            .strip_prefix('\'')
            .and_then(|s| s.strip_suffix('\''))
        else {
            return Err(CommunityDeployError::ComposeConfigInvalid);
        };
        if inner.contains('\'') {
            return Err(CommunityDeployError::ComposeConfigInvalid);
        }
        return Ok(inner);
    }
    if trimmed.contains('"') || trimmed.contains('\'') {
        return Err(CommunityDeployError::ComposeConfigInvalid);
    }
    Ok(trimmed)
}

const fn is_sorted_str_slice(slice: &[&str]) -> bool {
    let mut i = 1;
    while i < slice.len() {
        let left = slice[i - 1].as_bytes();
        let right = slice[i].as_bytes();
        let min_len = if left.len() < right.len() {
            left.len()
        } else {
            right.len()
        };
        let mut j = 0;
        let mut decided = false;
        while j < min_len {
            if left[j] < right[j] {
                decided = true;
                break;
            }
            if left[j] > right[j] {
                return false;
            }
            j += 1;
        }
        if !decided && left.len() >= right.len() {
            return false;
        }
        i += 1;
    }
    true
}

fn is_yaml_block_scalar_header(uncommented: &str) -> bool {
    let rhs = if let Some((_, after_colon)) = uncommented.split_once(':') {
        after_colon.trim()
    } else if let Some(after_dash) = uncommented.strip_prefix("- ") {
        after_dash.trim()
    } else {
        return false;
    };
    matches!(rhs, "|" | "|-" | "|+" | ">" | ">-" | ">+")
}

const fn str_eq_const(a: &str, b: &str) -> bool {
    let ab = a.as_bytes();
    let bb = b.as_bytes();
    if ab.len() != bb.len() {
        return false;
    }
    let mut idx = 0;
    while idx < ab.len() {
        if ab[idx] != bb[idx] {
            return false;
        }
        idx += 1;
    }
    true
}

const fn slices_are_disjoint(a: &[&str], b: &[&str]) -> bool {
    let mut i = 0;
    while i < a.len() {
        let mut j = 0;
        while j < b.len() {
            if str_eq_const(a[i], b[j]) {
                return false;
            }
            j += 1;
        }
        i += 1;
    }
    true
}

#[derive(Default)]
struct YamlBuildBlockState {
    active: bool,
    subkey_indent: Option<usize>,
    in_args_block: bool,
    args_item_indent: Option<usize>,
    saw_context: bool,
    saw_dockerfile: bool,
}

#[derive(Default)]
struct YamlArgvBlockState {
    active: bool,
    service_name: String,
    is_entrypoint: bool,
    items: Vec<String>,
    collecting_script: bool,
    script_base_indent: Option<usize>,
    script_lines: Vec<String>,
}

fn finalize_yaml_build_block(state: &mut YamlBuildBlockState) -> Result<(), CommunityDeployError> {
    if state.active && (!state.saw_context || !state.saw_dockerfile) {
        return Err(CommunityDeployError::ComposeConfigInvalid);
    }
    *state = YamlBuildBlockState::default();
    Ok(())
}

fn finalize_yaml_argv_block(state: &mut YamlArgvBlockState) -> Result<(), CommunityDeployError> {
    if state.active {
        let mut complete_items = state.items.clone();
        if state.collecting_script {
            complete_items.push(state.script_lines.join("\n"));
        }
        if complete_items.is_empty() {
            return Err(CommunityDeployError::ComposeConfigInvalid);
        }
        if state.is_entrypoint {
            let entrypoint_ok = match state.service_name.as_str() {
                "synapse" => {
                    complete_items.len() == 3
                        && complete_items[0] == "/bin/sh"
                        && complete_items[1] == "-c"
                        && matches_canonical_synapse_entrypoint_script(&complete_items[2])
                }
                "web" => {
                    complete_items.len() == 4
                        && complete_items[0] == "/bin/sh"
                        && complete_items[1] == "-ec"
                        && matches_canonical_web_entrypoint_script(&complete_items[2])
                        && complete_items[3] == "sh"
                }
                _ => false,
            };
            if !entrypoint_ok {
                return Err(CommunityDeployError::ComposeConfigInvalid);
            }
        } else {
            let refs: Vec<&str> = complete_items.iter().map(String::as_str).collect();
            validate_service_command_argv(&state.service_name, &refs, true)?;
        }
    }
    *state = YamlArgvBlockState::default();
    Ok(())
}

fn validate_inline_yaml_command(
    service_name: &str,
    rest: &str,
) -> Result<(), CommunityDeployError> {
    if rest.starts_with('[') {
        let parsed: Vec<String> =
            serde_json::from_str(rest).map_err(|_| CommunityDeployError::ComposeConfigInvalid)?;
        let refs: Vec<&str> = parsed.iter().map(String::as_str).collect();
        return validate_service_command_argv(service_name, &refs, true);
    }
    let unquoted = unquote_yaml_scalar(rest)?;
    if service_name == "livekit" && unquoted == "--config /etc/livekit.yaml" {
        return Ok(());
    }
    Err(CommunityDeployError::ComposeConfigInvalid)
}

fn finalize_yaml_service(
    current_service: &mut Option<String>,
    saw_image_or_build: &mut bool,
    build_state: &mut YamlBuildBlockState,
    argv_state: &mut YamlArgvBlockState,
) -> Result<(), CommunityDeployError> {
    finalize_yaml_build_block(build_state)?;
    finalize_yaml_argv_block(argv_state)?;
    if current_service.is_some() && !*saw_image_or_build {
        return Err(CommunityDeployError::ComposeConfigInvalid);
    }
    *current_service = None;
    *saw_image_or_build = false;
    Ok(())
}

pub(super) fn validate_compose_file_policy(
    compose_path: &Path,
) -> Result<(), CommunityDeployError> {
    const {
        assert!(
            is_sorted_str_slice(ADMITTED_COMPOSE_SERVICE_DIRECTIVES),
            "ADMITTED_COMPOSE_SERVICE_DIRECTIVES must be sorted"
        );
        assert!(
            is_sorted_str_slice(FORBIDDEN_PRIVILEGED_COMPOSE_DIRECTIVES),
            "FORBIDDEN_PRIVILEGED_COMPOSE_DIRECTIVES must be sorted"
        );
        assert!(
            slices_are_disjoint(
                ADMITTED_COMPOSE_SERVICE_DIRECTIVES,
                FORBIDDEN_PRIVILEGED_COMPOSE_DIRECTIVES,
            ),
            "forbidden directives must never appear in ADMITTED_COMPOSE_SERVICE_DIRECTIVES"
        );
    }

    let meta =
        fs::symlink_metadata(compose_path).map_err(|_| CommunityDeployError::ComposeFileMissing)?;
    if meta.file_type().is_symlink() {
        return Err(CommunityDeployError::SymlinkRejected);
    }
    if !meta.file_type().is_file() || meta.len() == 0 {
        return Err(CommunityDeployError::ComposeFileMissing);
    }
    if meta.len() > MAX_COMPOSE_FILE_BYTES {
        return Err(CommunityDeployError::ComposeConfigInvalid);
    }

    let raw =
        fs::read_to_string(compose_path).map_err(|_| CommunityDeployError::ComposeConfigInvalid)?;
    if raw.contains('\0') {
        return Err(CommunityDeployError::ComposeConfigInvalid);
    }

    let mut saw_services_root = false;
    let mut service_count = 0usize;
    let mut root_section: Option<&str> = None;
    let mut service_indent: Option<usize> = None;
    let mut current_service: Option<String> = None;
    let mut current_service_has_image_or_build = false;
    let mut directive_indent: Option<usize> = None;
    let mut current_directive: Option<String> = None;
    let mut current_directive_inline_scalar = false;
    let mut build_state = YamlBuildBlockState::default();
    let mut argv_state = YamlArgvBlockState::default();
    let mut env_item_indent: Option<usize> = None;
    let mut top_vol_indent: Option<usize> = None;
    let mut top_net_indent: Option<usize> = None;
    let mut in_multiline_scalar_indent: Option<usize> = None;

    for line in raw.lines() {
        let trimmed_ws = line.trim();
        if trimmed_ws.is_empty() {
            continue;
        }
        let indent = line.bytes().take_while(|b| *b == b' ').count();
        if line.as_bytes().get(indent) == Some(&b'\t') {
            return Err(CommunityDeployError::ComposeConfigInvalid);
        }

        if let Some(block_indent) = in_multiline_scalar_indent {
            if indent > block_indent {
                if argv_state.active && argv_state.collecting_script {
                    let base = *argv_state.script_base_indent.get_or_insert(indent);
                    if indent < base {
                        return Err(CommunityDeployError::ComposeConfigInvalid);
                    }
                    argv_state.script_lines.push(line[base..].to_owned());
                }
                continue;
            }
            in_multiline_scalar_indent = None;
        }

        if trimmed_ws.starts_with('#') {
            continue;
        }

        let uncommented = strip_inline_yaml_comment(trimmed_ws).trim();
        if uncommented.is_empty() {
            continue;
        }
        if uncommented == "---"
            || uncommented == "..."
            || uncommented.contains("<<:")
            || contains_unquoted_yaml_anchor_or_alias(uncommented)
        {
            return Err(CommunityDeployError::ComposeConfigInvalid);
        }

        if is_yaml_block_scalar_header(uncommented) {
            in_multiline_scalar_indent = Some(indent);
        }

        if indent == 0 {
            finalize_yaml_service(
                &mut current_service,
                &mut current_service_has_image_or_build,
                &mut build_state,
                &mut argv_state,
            )?;
            service_indent = None;
            directive_indent = None;
            current_directive = None;
            top_vol_indent = None;
            top_net_indent = None;

            let Some((root_key, root_rest)) = uncommented.split_once(':') else {
                return Err(CommunityDeployError::ComposeConfigInvalid);
            };
            let key = root_key.trim();
            let rest = root_rest.trim();
            match key {
                "services" => {
                    if !rest.is_empty() {
                        return Err(CommunityDeployError::ComposeConfigInvalid);
                    }
                    saw_services_root = true;
                    root_section = Some("services");
                }
                "volumes" => {
                    if !rest.is_empty() && rest != "{}" {
                        return Err(CommunityDeployError::ComposeConfigInvalid);
                    }
                    root_section = Some("volumes");
                }
                "networks" => {
                    if !rest.is_empty() && rest != "{}" {
                        return Err(CommunityDeployError::ComposeConfigInvalid);
                    }
                    root_section = Some("networks");
                }
                "name" | "version" => {
                    if rest.starts_with('{') || rest.starts_with('[') {
                        return Err(CommunityDeployError::ComposeConfigInvalid);
                    }
                    root_section = Some("scalar");
                }
                _ => return Err(CommunityDeployError::ComposeConfigInvalid),
            }
            continue;
        }

        match root_section {
            Some("services") => {
                let svc_ind = *service_indent.get_or_insert(indent);
                if indent < svc_ind {
                    return Err(CommunityDeployError::ComposeConfigInvalid);
                }
                if indent == svc_ind {
                    finalize_yaml_service(
                        &mut current_service,
                        &mut current_service_has_image_or_build,
                        &mut build_state,
                        &mut argv_state,
                    )?;
                    directive_indent = None;
                    current_directive = None;
                    env_item_indent = None;
                    let Some((svc_name_raw, svc_rest_raw)) = uncommented.split_once(':') else {
                        return Err(CommunityDeployError::ComposeConfigInvalid);
                    };
                    let svc = svc_name_raw.trim();
                    let rest = svc_rest_raw.trim();
                    if !rest.is_empty()
                        || ADMITTED_COMMUNITY_COMPOSE_SERVICES
                            .binary_search(&svc)
                            .is_err()
                    {
                        return Err(CommunityDeployError::ComposeConfigInvalid);
                    }
                    current_service = Some(svc.to_owned());
                    current_service_has_image_or_build = false;
                    service_count += 1;
                    continue;
                }

                let dir_ind = *directive_indent.get_or_insert(indent);
                if indent < dir_ind {
                    return Err(CommunityDeployError::ComposeConfigInvalid);
                }
                if indent == dir_ind {
                    finalize_yaml_build_block(&mut build_state)?;
                    finalize_yaml_argv_block(&mut argv_state)?;
                    env_item_indent = None;
                    let Some((dir_raw, dir_rest_raw)) = uncommented.split_once(':') else {
                        return Err(CommunityDeployError::ComposeConfigInvalid);
                    };
                    let directive = dir_raw.trim();
                    let rest = dir_rest_raw.trim();
                    if ADMITTED_COMPOSE_SERVICE_DIRECTIVES
                        .binary_search(&directive)
                        .is_err()
                    {
                        return Err(CommunityDeployError::ComposeConfigInvalid);
                    }
                    match directive {
                        "build" => {
                            let svc_name = current_service.as_deref().unwrap_or("");
                            if !rest.is_empty() || expected_service_build_spec(svc_name).is_none() {
                                return Err(CommunityDeployError::ComposeConfigInvalid);
                            }
                            build_state.active = true;
                            current_service_has_image_or_build = true;
                        }
                        "image" => {
                            let svc_name = current_service.as_deref().unwrap_or("");
                            let img_val = unquote_yaml_scalar(rest)?;
                            if !is_admitted_service_image(svc_name, img_val) {
                                return Err(CommunityDeployError::ComposeConfigInvalid);
                            }
                            current_service_has_image_or_build = true;
                        }
                        "entrypoint" => {
                            let Some(svc_name) = current_service
                                .as_deref()
                                .filter(|s| matches!(*s, "synapse" | "web"))
                            else {
                                return Err(CommunityDeployError::ComposeConfigInvalid);
                            };
                            if !rest.is_empty() {
                                return Err(CommunityDeployError::ComposeConfigInvalid);
                            }
                            argv_state = YamlArgvBlockState {
                                active: true,
                                service_name: svc_name.to_owned(),
                                is_entrypoint: true,
                                ..YamlArgvBlockState::default()
                            };
                        }
                        "command" => {
                            let svc_name = current_service.as_deref().unwrap_or("");
                            if rest.is_empty() {
                                argv_state = YamlArgvBlockState {
                                    active: true,
                                    service_name: svc_name.to_owned(),
                                    is_entrypoint: false,
                                    ..YamlArgvBlockState::default()
                                };
                            } else {
                                validate_inline_yaml_command(svc_name, rest)?;
                            }
                        }
                        "user" => {
                            let svc_name = current_service.as_deref().unwrap_or("");
                            let user_val = unquote_yaml_scalar(rest)?;
                            if !is_admitted_service_user(svc_name, user_val) {
                                return Err(CommunityDeployError::ComposeConfigInvalid);
                            }
                        }
                        "environment" => {
                            let svc_name = current_service.as_deref().unwrap_or("");
                            if !rest.is_empty()
                                || admitted_service_environment_keys(svc_name).is_empty()
                            {
                                return Err(CommunityDeployError::ComposeConfigInvalid);
                            }
                        }
                        "ports" => {
                            let svc_name = current_service.as_deref().unwrap_or("");
                            if !matches!(svc_name, "caddy" | "livekit")
                                || (!rest.is_empty() && rest != "[]")
                            {
                                return Err(CommunityDeployError::ComposeConfigInvalid);
                            }
                        }
                        "cap_add" => {
                            if !rest.is_empty() {
                                validate_inline_cap_add_list(rest)?;
                            }
                        }
                        "cap_drop" => {
                            if !rest.is_empty() {
                                validate_inline_cap_drop_list(rest)?;
                            }
                        }
                        "security_opt" => {
                            if !rest.is_empty() {
                                validate_inline_security_opt_list(rest)?;
                            }
                        }
                        "volumes" if !rest.is_empty() && rest != "[]" => {
                            return Err(CommunityDeployError::ComposeConfigInvalid);
                        }
                        _ => {}
                    }
                    current_directive = Some(directive.to_owned());
                    current_directive_inline_scalar =
                        !rest.is_empty() && !is_yaml_block_scalar_header(uncommented);
                    continue;
                }

                // `indent > dir_ind` — nested content inside `current_directive`.
                if current_directive_inline_scalar {
                    return Err(CommunityDeployError::ComposeConfigInvalid);
                }
                match current_directive.as_deref() {
                    Some("build") => {
                        if in_multiline_scalar_indent.is_some() {
                            return Err(CommunityDeployError::ComposeConfigInvalid);
                        }
                        let svc_name = current_service.as_deref().unwrap_or("");
                        let Some(spec) = expected_service_build_spec(svc_name) else {
                            return Err(CommunityDeployError::ComposeConfigInvalid);
                        };
                        let b_ind = *build_state.subkey_indent.get_or_insert(indent);
                        if indent < b_ind {
                            return Err(CommunityDeployError::ComposeConfigInvalid);
                        }
                        if indent == b_ind {
                            build_state.in_args_block = false;
                            build_state.args_item_indent = None;
                            let Some((bk_raw, bv_raw)) = uncommented.split_once(':') else {
                                return Err(CommunityDeployError::ComposeConfigInvalid);
                            };
                            let bk = bk_raw.trim();
                            let bv_trimmed = bv_raw.trim();
                            match bk {
                                "context" => {
                                    if build_state.saw_context {
                                        return Err(CommunityDeployError::ComposeConfigInvalid);
                                    }
                                    let ctx_val = unquote_yaml_scalar(bv_trimmed)?;
                                    if !is_admitted_yaml_build_context(
                                        ctx_val,
                                        spec.context_subpath,
                                    ) {
                                        return Err(CommunityDeployError::ComposeConfigInvalid);
                                    }
                                    build_state.saw_context = true;
                                }
                                "dockerfile" => {
                                    if build_state.saw_dockerfile {
                                        return Err(CommunityDeployError::ComposeConfigInvalid);
                                    }
                                    let df_val = unquote_yaml_scalar(bv_trimmed)?;
                                    if df_val != spec.dockerfile {
                                        return Err(CommunityDeployError::ComposeConfigInvalid);
                                    }
                                    build_state.saw_dockerfile = true;
                                }
                                "args" if spec.allow_vite_args => {
                                    if !bv_trimmed.is_empty() {
                                        return Err(CommunityDeployError::ComposeConfigInvalid);
                                    }
                                    build_state.in_args_block = true;
                                }
                                _ => return Err(CommunityDeployError::ComposeConfigInvalid),
                            }
                        } else {
                            if !build_state.in_args_block || !spec.allow_vite_args {
                                return Err(CommunityDeployError::ComposeConfigInvalid);
                            }
                            let a_ind = *build_state.args_item_indent.get_or_insert(indent);
                            if indent != a_ind {
                                return Err(CommunityDeployError::ComposeConfigInvalid);
                            }
                            let Some((arg_k_raw, arg_v_raw)) = uncommented.split_once(':') else {
                                return Err(CommunityDeployError::ComposeConfigInvalid);
                            };
                            let arg_k = arg_k_raw.trim();
                            let arg_v = arg_v_raw.trim();
                            if !is_admitted_vite_build_arg_key(arg_k)
                                || arg_v.is_empty()
                                || arg_v.starts_with('{')
                                || arg_v.starts_with('[')
                                || arg_v.starts_with('|')
                                || arg_v.starts_with('>')
                            {
                                return Err(CommunityDeployError::ComposeConfigInvalid);
                            }
                        }
                    }
                    Some("volumes") => {
                        let Some(volume_spec) = uncommented.strip_prefix("- ") else {
                            return Err(CommunityDeployError::ComposeConfigInvalid);
                        };
                        if volume_spec.contains("type:")
                            || volume_spec.starts_with('{')
                            || volume_spec.starts_with('[')
                        {
                            return Err(CommunityDeployError::ComposeConfigInvalid);
                        }
                        validate_compose_volume_entry(volume_spec)?;
                    }
                    Some("cap_add") => {
                        let Some(cap_spec) = uncommented.strip_prefix("- ") else {
                            return Err(CommunityDeployError::ComposeConfigInvalid);
                        };
                        if !is_admitted_cap_add_token(cap_spec) {
                            return Err(CommunityDeployError::ComposeConfigInvalid);
                        }
                    }
                    Some("cap_drop") => {
                        let Some(cap_spec) = uncommented.strip_prefix("- ") else {
                            return Err(CommunityDeployError::ComposeConfigInvalid);
                        };
                        if !is_admitted_cap_drop_token(cap_spec) {
                            return Err(CommunityDeployError::ComposeConfigInvalid);
                        }
                    }
                    Some("security_opt") => {
                        let Some(opt_spec) = uncommented.strip_prefix("- ") else {
                            return Err(CommunityDeployError::ComposeConfigInvalid);
                        };
                        let opt = opt_spec.trim().trim_matches(|c| matches!(c, '"' | '\''));
                        if opt != "no-new-privileges:true" {
                            return Err(CommunityDeployError::ComposeConfigInvalid);
                        }
                    }
                    Some("ports") => {
                        let Some(port_spec) = uncommented.strip_prefix("- ") else {
                            return Err(CommunityDeployError::ComposeConfigInvalid);
                        };
                        let svc_name = current_service.as_deref().unwrap_or("");
                        validate_yaml_port_entry(svc_name, port_spec)?;
                    }
                    Some("entrypoint" | "command") => {
                        if !argv_state.active || argv_state.collecting_script {
                            return Err(CommunityDeployError::ComposeConfigInvalid);
                        }
                        let Some(item_spec) = uncommented.strip_prefix("- ") else {
                            return Err(CommunityDeployError::ComposeConfigInvalid);
                        };
                        let trimmed_item = item_spec.trim();
                        if matches!(trimmed_item, "|" | "|-" | "|+") {
                            argv_state.collecting_script = true;
                        } else {
                            let item_val = unquote_yaml_scalar(trimmed_item)?;
                            argv_state.items.push(item_val.to_owned());
                        }
                    }
                    Some("environment") => {
                        if in_multiline_scalar_indent.is_some() {
                            return Err(CommunityDeployError::ComposeConfigInvalid);
                        }
                        let e_ind = *env_item_indent.get_or_insert(indent);
                        if indent != e_ind {
                            return Err(CommunityDeployError::ComposeConfigInvalid);
                        }
                        let svc_name = current_service.as_deref().unwrap_or("");
                        if let Some(list_item) = uncommented.strip_prefix("- ") {
                            let cleaned = unquote_yaml_scalar(list_item)?;
                            let (k, v_opt) = match cleaned.split_once('=') {
                                Some((k, v)) => (k.trim(), Some(v.trim())),
                                None => (cleaned.trim(), None),
                            };
                            if !is_admitted_service_env_var(svc_name, k, v_opt) {
                                return Err(CommunityDeployError::ComposeConfigInvalid);
                            }
                        } else {
                            let Some((env_k_raw, env_v_raw)) = uncommented.split_once(':') else {
                                return Err(CommunityDeployError::ComposeConfigInvalid);
                            };
                            let env_k = env_k_raw.trim();
                            let env_v = env_v_raw.trim();
                            if env_v.starts_with('{')
                                || env_v.starts_with('[')
                                || env_v.starts_with('|')
                                || env_v.starts_with('>')
                            {
                                return Err(CommunityDeployError::ComposeConfigInvalid);
                            }
                            let unquoted_v = if env_v.is_empty() {
                                ""
                            } else {
                                unquote_yaml_scalar(env_v)?
                            };
                            if !is_admitted_service_env_var(svc_name, env_k, Some(unquoted_v)) {
                                return Err(CommunityDeployError::ComposeConfigInvalid);
                            }
                        }
                    }
                    Some("depends_on" | "healthcheck" | "networks" | "profiles") => {}
                    _ => return Err(CommunityDeployError::ComposeConfigInvalid),
                }
            }
            Some("volumes") => {
                let v_ind = *top_vol_indent.get_or_insert(indent);
                if indent != v_ind {
                    return Err(CommunityDeployError::ComposeConfigInvalid);
                }
                let Some((vol_raw, vol_rest_raw)) = uncommented.split_once(':') else {
                    return Err(CommunityDeployError::ComposeConfigInvalid);
                };
                let vol_name = vol_raw.trim();
                let rest = vol_rest_raw.trim();
                if !is_admitted_named_volume_source(vol_name)
                    || (!rest.is_empty() && rest != "{}" && rest != "null")
                {
                    return Err(CommunityDeployError::ComposeConfigInvalid);
                }
            }
            Some("networks") => {
                let n_ind = *top_net_indent.get_or_insert(indent);
                if indent < n_ind {
                    return Err(CommunityDeployError::ComposeConfigInvalid);
                }
                if indent == n_ind {
                    let Some((net_name_raw, net_rest_raw)) = uncommented.split_once(':') else {
                        return Err(CommunityDeployError::ComposeConfigInvalid);
                    };
                    let net_name = net_name_raw.trim();
                    let rest = net_rest_raw.trim();
                    if !is_admitted_named_volume_source(net_name)
                        || (!rest.is_empty() && rest != "{}" && rest != "null")
                    {
                        return Err(CommunityDeployError::ComposeConfigInvalid);
                    }
                } else {
                    let cleaned = uncommented.strip_prefix("- ").unwrap_or(uncommented);
                    let Some((net_k, net_v)) = cleaned.split_once(':') else {
                        return Err(CommunityDeployError::ComposeConfigInvalid);
                    };
                    let nk = net_k.trim();
                    let nv = net_v.trim().trim_matches(|c| matches!(c, '"' | '\''));
                    match nk {
                        "internal" if matches!(nv, "true" | "false") => {}
                        "driver" if nv == "bridge" => {}
                        "ipam" | "config" if nv.is_empty() => {}
                        "subnet" | "ip_range" if !nv.is_empty() => {}
                        _ => return Err(CommunityDeployError::ComposeConfigInvalid),
                    }
                }
            }
            _ => return Err(CommunityDeployError::ComposeConfigInvalid),
        }
    }

    finalize_yaml_service(
        &mut current_service,
        &mut current_service_has_image_or_build,
        &mut build_state,
        &mut argv_state,
    )?;

    if !saw_services_root || service_count == 0 {
        return Err(CommunityDeployError::ComposeConfigInvalid);
    }

    Ok(())
}
