use super::*;

#[test]
fn plan_request_and_success_response_do_not_reflect_token() {
    let request = plan_request(ORG, TOKEN);
    assert!(!format!("{request:?}").contains(TOKEN));
    assert!(!format!("{request}").contains(TOKEN));
    let response = session().execute_command(request);
    assert!(matches!(response, DesktopCommandResponse::SelfHostPlan(_)));
    assert!(!format!("{response:?}").contains(TOKEN));
    assert!(!format!("{response}").contains(TOKEN));
}

#[test]
fn public_field_token_alias_and_trimmed_alias_are_refused() {
    for token in [
        "sensitive.example.org",
        "  sensitive.example.org  ",
        "SENSITIVE.EXAMPLE.ORG",
        "  SENSITIVE.EXAMPLE.ORG  ",
    ] {
        let request = DesktopCommandRequest::PlanSelfHost {
            organisation_id: ORG.to_owned(),
            provider: CloudProvider::Hetzner,
            region: "fsn1".to_owned(),
            fqdn: token.trim().to_owned(),
            acme_email: "ops@example.org".to_owned(),
            token: RedactedApiToken::new(token).unwrap(),
        };
        assert!(!format!("{request:?}").contains("sensitive.example.org"));
        let response = session().execute_command(request);
        assert_eq!(
            response,
            DesktopCommandResponse::Error(DesktopCommandError::SecretInPublicPlan)
        );
        assert!(!format!("{response:?}").contains("sensitive.example.org"));
    }
}

#[test]
fn invalid_plan_returns_only_closed_error_and_preserves_session() {
    let mut session = session();
    let mut request = plan_request(ORG, TOKEN);
    if let DesktopCommandRequest::PlanSelfHost { acme_email, .. } = &mut request {
        *acme_email = TOKEN.to_owned();
    }
    let response = session.execute_command(request);
    assert_eq!(
        response,
        DesktopCommandResponse::Error(DesktopCommandError::Deployment(
            DeployValidationError::InvalidAdminEmail
        ))
    );
    assert!(!format!("{response:?}").contains(TOKEN));
    assert_eq!(session.sound_pack(ORG), Ok(SoundPackId::Givre));
}

#[test]
fn all_typed_commands_are_organisation_fenced_before_any_effect() {
    let mut session = session();
    populate(&mut session, 1, 1);
    let commands = [
        plan_request(OTHER_ORG, TOKEN),
        DesktopCommandRequest::ValidateDocsPadUrl {
            organisation_id: OTHER_ORG.to_owned(),
            raw_url: "https://docs.example.org/docs/one".to_owned(),
        },
        DesktopCommandRequest::ProximityCurrentBeacon {
            organisation_id: OTHER_ORG.to_owned(),
            now_unix_secs: 1,
        },
        DesktopCommandRequest::ProximityMemberStatuses {
            organisation_id: OTHER_ORG.to_owned(),
        },
        DesktopCommandRequest::ProximityNextRelayBatch {
            organisation_id: OTHER_ORG.to_owned(),
            max_frames: usize::MAX,
        },
        DesktopCommandRequest::ClearWorkspaceSession {
            organisation_id: OTHER_ORG.to_owned(),
        },
        DesktopCommandRequest::SetSoundPack {
            organisation_id: OTHER_ORG.to_owned(),
            sound_pack: SoundPackId::Silent,
        },
        DesktopCommandRequest::GetSoundPack {
            organisation_id: OTHER_ORG.to_owned(),
        },
    ];
    for request in commands {
        assert_eq!(
            session.execute_command(request),
            DesktopCommandResponse::Error(DesktopCommandError::Core(
                CoreError::OrganisationMismatch
            ))
        );
        assert_eq!(session.sound_pack(ORG), Ok(SoundPackId::Givre));
        assert_eq!(session.member_statuses(ORG).unwrap().len(), 1);
    }
    assert_eq!(session.next_relay_batch(ORG, 1).unwrap().len(), 1);
}

#[test]
fn docs_command_requires_provisioned_host_and_returns_canonical_metadata() {
    let mut session = session();
    let make = || DesktopCommandRequest::ValidateDocsPadUrl {
        organisation_id: ORG.to_owned(),
        raw_url: "https://docs.example.org:443/pads/one".to_owned(),
    };
    assert_eq!(
        session.execute_command(make()),
        DesktopCommandResponse::Error(DesktopCommandError::Core(CoreError::TransportUnavailable))
    );
    session
        .configure_docs_host(ORG, Some("docs.example.org"))
        .unwrap();
    let DesktopCommandResponse::DocsPadUrl(url) = session.execute_command(make()) else {
        panic!("expected metadata")
    };
    assert_eq!(url.as_str(), "https://docs.example.org/pads/one");
}

#[test]
fn beacon_response_has_same_bytes_and_canonical_hex() {
    let response = session().execute_command(DesktopCommandRequest::ProximityCurrentBeacon {
        organisation_id: ORG.to_owned(),
        now_unix_secs: 1_762_520_100,
    });
    assert_eq!(
        response,
        DesktopCommandResponse::ProximityBeacon {
            bytes: [0x1b, 0xe3, 0x96, 0x76, 0x37, 0xeb, 0xb0, 0xea],
            hex: "1be3967637ebb0ea".to_owned(),
        }
    );
}

#[test]
fn member_status_response_is_sorted_and_preserves_verified_metadata() {
    let mut session = session();
    populate(&mut session, 2, 2);
    populate(&mut session, 1, 1);
    let DesktopCommandResponse::ProximityMemberStatuses(statuses) =
        session.execute_command(DesktopCommandRequest::ProximityMemberStatuses {
            organisation_id: ORG.to_owned(),
        })
    else {
        panic!("expected roster")
    };
    assert_eq!(
        statuses
            .iter()
            .map(|m| m.sender_public_key)
            .collect::<Vec<_>>(),
        vec![[1; 32], [2; 32]]
    );
    assert_eq!(statuses[0].timestamp_ms, 1);
    assert_eq!(statuses[0].text, "Local fixture");
}

#[test]
fn relay_batch_zero_and_large_limits_are_bounded_and_drain_once() {
    let mut session = session();
    populate(&mut session, 1, 1);
    populate(&mut session, 2, 2);
    let request = |max_frames| DesktopCommandRequest::ProximityNextRelayBatch {
        organisation_id: ORG.to_owned(),
        max_frames,
    };
    assert_eq!(
        session.execute_command(request(0)),
        DesktopCommandResponse::ProximityRelayBatch(vec![])
    );
    let DesktopCommandResponse::ProximityRelayBatch(frames) =
        session.execute_command(request(usize::MAX))
    else {
        panic!("expected frames")
    };
    assert_eq!(frames.len(), 2);
    assert_eq!(
        session.execute_command(request(1)),
        DesktopCommandResponse::ProximityRelayBatch(vec![])
    );
}

#[test]
fn sound_pack_commands_round_trip_without_audio_activation() {
    let mut session = session();
    for sound_pack in [
        SoundPackId::Givre,
        SoundPackId::Cristal,
        SoundPackId::Atelier,
        SoundPackId::Arcade8Bit,
        SoundPackId::Glitch404,
        SoundPackId::Silent,
    ] {
        assert_eq!(
            session.execute_command(DesktopCommandRequest::SetSoundPack {
                organisation_id: ORG.to_owned(),
                sound_pack
            }),
            DesktopCommandResponse::SoundPack(sound_pack)
        );
        assert_eq!(
            session.execute_command(DesktopCommandRequest::GetSoundPack {
                organisation_id: ORG.to_owned()
            }),
            DesktopCommandResponse::SoundPack(sound_pack)
        );
    }
}

#[test]
fn clear_removes_all_state_and_later_commands_fail_closed() {
    let mut session = session();
    populate(&mut session, 1, 1);
    session
        .configure_docs_host(ORG, Some("docs.example.org"))
        .unwrap();
    session.set_sound_pack(ORG, SoundPackId::Silent).unwrap();
    assert_eq!(
        session.execute_command(DesktopCommandRequest::ClearWorkspaceSession {
            organisation_id: ORG.to_owned()
        }),
        DesktopCommandResponse::WorkspaceSessionCleared
    );
    assert!(
        session.organisation_id.is_none()
            && session.proximity.is_none()
            && session.allowed_docs_host.is_none()
            && session.extension_webhooks.is_none()
            && session.sound_pack.is_none()
    );
    assert_eq!(
        session.execute_command(DesktopCommandRequest::GetSoundPack {
            organisation_id: ORG.to_owned()
        }),
        DesktopCommandResponse::Error(DesktopCommandError::Core(CoreError::TransportUnavailable))
    );
    assert_eq!(
        session.execute_command(DesktopCommandRequest::ClearWorkspaceSession {
            organisation_id: ORG.to_owned()
        }),
        DesktopCommandResponse::Error(DesktopCommandError::Core(CoreError::TransportUnavailable))
    );
}

#[test]
fn organisation_switch_resets_sound_and_old_clear_cannot_end_replacement() {
    let mut session = session();
    session.set_sound_pack(ORG, SoundPackId::Silent).unwrap();
    session
        .switch_organisation(OTHER_ORG, [0x43; 32], HashSet::new(), 2)
        .unwrap();
    assert_eq!(session.sound_pack(OTHER_ORG), Ok(SoundPackId::Givre));
    assert_eq!(
        session.execute_command(DesktopCommandRequest::ClearWorkspaceSession {
            organisation_id: ORG.to_owned()
        }),
        DesktopCommandResponse::Error(DesktopCommandError::Core(CoreError::OrganisationMismatch))
    );
    assert_eq!(session.sound_pack(OTHER_ORG), Ok(SoundPackId::Givre));
    assert!(session
        .switch_organisation("invalid", [0; 32], HashSet::new(), 2)
        .is_err());
    assert!(session.sound_pack.is_none());
}

#[test]
fn raw_json_routes_all_operations_and_never_reflects_plan_token() {
    let mut session = session();
    let plan = json(
        "plan_self_host",
        &format!(
            r#", "provider":"scaleway","region":"fr-par-1","fqdn":"chat.example.org","acme_email":"ops@example.org","raw_token":"{TOKEN}""#
        ),
    );
    let response = session.dispatch_command(&plan);
    assert!(matches!(response, DesktopCommandResponse::SelfHostPlan(_)));
    assert!(!format!("{response:?}").contains(TOKEN));
    session
        .configure_docs_host(ORG, Some("docs.example.org"))
        .unwrap();
    assert!(matches!(
        session.dispatch_command(&json(
            "validate_docs_pad_url",
            r#", "raw_url":"https://docs.example.org/docs/one""#
        )),
        DesktopCommandResponse::DocsPadUrl(_)
    ));
    assert!(matches!(
        session.dispatch_command(&json(
            "proximity_current_beacon",
            r#", "now_unix_secs":1762520100"#
        )),
        DesktopCommandResponse::ProximityBeacon { .. }
    ));
    assert_eq!(
        session.dispatch_command(&json("proximity_member_statuses", "")),
        DesktopCommandResponse::ProximityMemberStatuses(vec![])
    );
    assert_eq!(
        session.dispatch_command(&json("proximity_next_relay_batch", r#", "max_frames":128"#)),
        DesktopCommandResponse::ProximityRelayBatch(vec![])
    );
    assert_eq!(
        session.dispatch_command(&json("set_sound_pack", r#", "sound_pack":"404""#)),
        DesktopCommandResponse::SoundPack(SoundPackId::Glitch404)
    );
    assert_eq!(
        session.dispatch_command(&json("get_sound_pack", "")),
        DesktopCommandResponse::SoundPack(SoundPackId::Glitch404)
    );
    assert_eq!(
        session.dispatch_command(&json("clear_workspace_session", "")),
        DesktopCommandResponse::WorkspaceSessionCleared
    );
    assert!(session.organisation_id().is_none());
}

#[test]
fn json_unknown_duplicate_and_escaped_duplicate_fields_never_clear_or_drain() {
    let mut session = session();
    populate(&mut session, 1, 1);
    for input in [
        json(
            "clear_workspace_session",
            r#", "unknown":"fixture-sensitive-field""#,
        ),
        json(
            "proximity_next_relay_batch",
            r#", "max_frames":128,"raw_token":"fixture-sensitive-field""#,
        ),
        json("clear_workspace_session", r#", "command":"get_sound_pack""#),
        json(
            "clear_workspace_session",
            &format!(r#", "organisation\u005fid":"{OTHER_ORG}""#),
        ),
    ] {
        assert_eq!(
            session.dispatch_command(&input),
            DesktopCommandResponse::Error(DesktopCommandError::InvalidRequest)
        );
        assert_eq!(session.sound_pack(ORG), Ok(SoundPackId::Givre));
        assert_eq!(session.member_statuses(ORG).unwrap().len(), 1);
    }
    assert_eq!(session.next_relay_batch(ORG, 128).unwrap().len(), 1);
}

#[test]
fn json_byte_bound_is_inclusive_and_checked_before_parsing() {
    let mut session = session();
    let request = json("get_sound_pack", "");
    let exact = request.clone() + &" ".repeat(MAX_IPC_COMMAND_BYTES - request.len());
    assert_eq!(exact.len(), MAX_IPC_COMMAND_BYTES);
    assert_eq!(
        session.dispatch_command(&exact),
        DesktopCommandResponse::SoundPack(SoundPackId::Givre)
    );
    assert_eq!(
        session.dispatch_command(&(exact + " ")),
        DesktopCommandResponse::Error(DesktopCommandError::RequestTooLarge)
    );
    assert_eq!(
        session.dispatch_command(&"é".repeat(MAX_IPC_COMMAND_BYTES / 2 + 1)),
        DesktopCommandResponse::Error(DesktopCommandError::RequestTooLarge)
    );
    assert_eq!(session.sound_pack(ORG), Ok(SoundPackId::Givre));
}

#[test]
fn json_integer_grammar_refuses_coercions_and_unsigned_overflow() {
    let mut session = session();
    for number in [
        "-1",
        "+1",
        "01",
        "1.0",
        "1e0",
        "18446744073709551616",
        "null",
        "false",
        r#""128""#,
    ] {
        assert_eq!(
            session.dispatch_command(&json(
                "proximity_next_relay_batch",
                &format!(",\"max_frames\":{number}")
            )),
            DesktopCommandResponse::Error(DesktopCommandError::InvalidRequest),
            "{number}"
        );
    }
    assert!(matches!(
        session.dispatch_command(&json(
            "proximity_current_beacon",
            ",\"now_unix_secs\":18446744073709551615"
        )),
        DesktopCommandResponse::ProximityBeacon { .. }
    ));
}

#[test]
fn json_strings_decode_standard_escapes_and_surrogate_pairs_without_diagnostic_leaks() {
    let escaped_doc = json(
        "save_docs_pad",
        r#", "pad_id":"pad-01","channel_id":"chan-01","title":"Title","markdown_body":"quote: \" slash: \\ emoji: \ud83e\udded","actor":"alice""#,
    );
    let doc_req = DesktopCommandRequest::from_json(&escaped_doc).unwrap();
    assert_eq!(format!("{doc_req:?}"), "DesktopCommandRequest([REDACTED])");
    let DesktopCommandRequest::SaveDocsPad { markdown_body, .. } = doc_req else {
        panic!("expected save_docs_pad")
    };
    assert_eq!(markdown_body, "quote: \" slash: \\ emoji: 🧭");

    let escaped = json(
        "plan_self_host",
        r#", "provider":"scaleway","region":"fr-par-1","fqdn":"chat.example.org","acme_email":"ops@example.org","raw_token":"scw_quote:\"slash:\\_012345""#,
    );
    let request = DesktopCommandRequest::from_json(&escaped).unwrap();
    assert_eq!(format!("{request:?}"), "DesktopCommandRequest([REDACTED])");
    let DesktopCommandRequest::PlanSelfHost { token, .. } = request else {
        panic!("expected plan")
    };
    assert_eq!(
        token.expose_for_provider_call(),
        "scw_quote:\"slash:\\_012345"
    );
    assert_eq!(
            DesktopCommandRequest::from_json(&json(
                "plan_self_host",
                r#", "provider":"scaleway","region":"fr-par-1","fqdn":"chat.example.org","acme_email":"ops@example.org","raw_token":"quote: \" slash: \\ emoji: \ud83e\udded""#,
            ))
            .unwrap_err(),
            DesktopCommandError::Deployment(DeployValidationError::TokenContainsWhitespace)
        );
    assert_eq!(
        session().dispatch_command(&json("set_sound_pack", r#", "sound_pack":"\u0067ivre""#)),
        DesktopCommandResponse::SoundPack(SoundPackId::Givre)
    );
}

#[test]
fn malformed_json_and_deep_inputs_cannot_mutate_workspace() {
    let mut session = session();
    let mut invalid = vec![
        "".to_owned(),
        "{}".to_owned(),
        "[]".to_owned(),
        "null".to_owned(),
        json("get_sound_pack", "") + "{}",
        json("get_sound_pack", ","),
        json("get_sound_pack", r#", "nested":{"a":1}"#),
        json("get_sound_pack", r#", "array":[1,2,3]"#),
    ];
    invalid.push("{\"command\":".to_owned() + &"[".repeat(4000) + &"]".repeat(4000) + "}");
    for bad_escape in [
        r#"\ud800"#,
        r#"\udfff"#,
        r#"\ud800\u0041"#,
        r#"\u0"#,
        r#"\q"#,
    ] {
        // Use an otherwise valid schema so semantic command rejection cannot mask a
        // decoder that accidentally accepts malformed string values.
        invalid.push(json("plan_self_host", &format!(r#", "provider":"scaleway","region":"fr-par-1","fqdn":"chat.example.org","acme_email":"ops@example.org","raw_token":"{bad_escape}""#)));
    }
    for input in invalid {
        assert!(matches!(
            DesktopCommandRequest::from_json(&input),
            Err(DesktopCommandError::InvalidRequest)
        ));
        assert_eq!(
            session.dispatch_command(&input),
            DesktopCommandResponse::Error(DesktopCommandError::InvalidRequest)
        );
        assert_eq!(session.sound_pack(ORG), Ok(SoundPackId::Givre));
    }
}

#[test]
fn missing_fields_wrong_types_unknown_commands_and_legacy_packs_are_closed_errors() {
    let mut session = session();
    for input in [
        r#"{"command":"clear_workspace_session"}"#.to_owned(),
        json("unknown", ""),
        json("set_sound_pack", ""),
        json("set_sound_pack", r#", "sound_pack":123"#),
        json("get_sound_pack", r#", "extra":"fixture-private-input""#),
    ] {
        let response = session.dispatch_command(&input);
        assert_eq!(
            response,
            DesktopCommandResponse::Error(DesktopCommandError::InvalidRequest)
        );
        assert!(!format!("{response:?}").contains("fixture-private-input"));
    }
    for slug in [
        "kodera-givre",
        "feutre",
        "impulsion",
        "8bit-atelier",
        "silencieux",
    ] {
        assert_eq!(
            session.dispatch_command(&json(
                "set_sound_pack",
                &format!(",\"sound_pack\":\"{slug}\"")
            )),
            DesktopCommandResponse::Error(DesktopCommandError::Core(CoreError::InvalidSoundPack))
        );
    }
}
