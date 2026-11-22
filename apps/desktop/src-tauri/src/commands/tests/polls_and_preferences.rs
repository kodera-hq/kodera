use super::*;

#[test]
fn poll_json_create_vote_read_close_routes_are_transactional_and_scoped() {
    let mut state = session();
    let DesktopCommandResponse::ChannelPoll(empty) = state.dispatch_command(&create_poll_json())
    else {
        panic!("expected poll")
    };
    assert_eq!(empty.total_votes, 0);
    let vote = poll_request(
        "vote_channel_poll",
        &format!(r#", "voter_id":"{ORG}","selections":[0,1]"#),
    );
    let DesktopCommandResponse::ChannelPoll(voted) = state.dispatch_command(&vote) else {
        panic!("expected vote")
    };
    assert_eq!(voted.total_votes, 1);
    assert_eq!(
        voted
            .options
            .iter()
            .map(|o| o.percentage)
            .collect::<Vec<_>>(),
        [100, 100]
    );
    assert_eq!(
        state.dispatch_command(&poll_request("get_channel_poll", "")),
        DesktopCommandResponse::ChannelPoll(voted.clone())
    );
    let wrong = vote.replace(ORG, OTHER_ORG);
    assert_eq!(
        state.dispatch_command(&wrong),
        DesktopCommandResponse::Error(DesktopCommandError::Core(CoreError::OrganisationMismatch))
    );
    assert_eq!(state.channel_poll(ORG, "text", "poll").unwrap(), voted);
    let DesktopCommandResponse::ChannelPoll(closed) =
        state.dispatch_command(&poll_request("close_channel_poll", ""))
    else {
        panic!("expected closed poll")
    };
    assert!(closed.is_closed);
    assert_eq!(
        state.dispatch_command(&vote),
        DesktopCommandResponse::Error(DesktopCommandError::Core(CoreError::PollClosed))
    );
    assert_eq!(
        state.dispatch_command(&create_poll_json()),
        DesktopCommandResponse::Error(DesktopCommandError::Core(CoreError::PollExists))
    );
    assert_eq!(state.channel_poll(ORG, "text", "poll").unwrap(), closed);
}
#[test]
fn poll_json_extensions_are_bounded_and_old_command_schemas_do_not_widen() {
    let mut state = session();
    state.dispatch_command(&create_poll_json());
    let original = state.channel_poll(ORG, "text", "poll").unwrap();
    let invalid = [
        create_poll_json().replace("true", "1"),
        create_poll_json().replace("true", "truefalse"),
        create_poll_json().replace(r#"["One","Two"]"#, r#"["One",2]"#),
        create_poll_json().replace(r#"["One","Two"]"#, r#"[["One"],"Two"]"#),
        create_poll_json().replace(r#"["One","Two"]"#, r#"["One","Two",]"#),
        create_poll_json().replace(
            r#"["One","Two"]"#,
            &format!("[{}]", (0..11).map(|_| "0").collect::<Vec<_>>().join(",")),
        ),
        poll_request("close_channel_poll", r#", "extra":[0]"#),
        poll_request(
            "vote_channel_poll",
            &format!(r#", "voter_id":"{ORG}", "selections":[true]"#),
        ),
        json("proximity_next_relay_batch", r#", "max_frames":[1]"#),
        json("get_sound_pack", r#", "extra":false"#),
    ];
    for input in invalid {
        assert_eq!(
            state.dispatch_command(&input),
            DesktopCommandResponse::Error(DesktopCommandError::InvalidRequest),
            "schema refusal"
        );
        assert_eq!(state.channel_poll(ORG, "text", "poll").unwrap(), original);
    }
    assert_eq!(
        state.dispatch_command(&poll_request(
            "vote_channel_poll",
            &format!(r#", "voter_id":"{ORG}","selections":[0,0]"#)
        )),
        DesktopCommandResponse::Error(DesktopCommandError::Core(CoreError::InvalidPollVote))
    );
    let huge = create_poll_json() + &" ".repeat(MAX_IPC_COMMAND_BYTES);
    assert_eq!(
        state.dispatch_command(&huge),
        DesktopCommandResponse::Error(DesktopCommandError::RequestTooLarge)
    );
}
#[test]
fn poll_session_capacity_scope_and_teardown_prevent_replacement_leaks() {
    let mut state = session();
    for index in 0..32 {
        state
            .create_channel_poll(
                ORG,
                "text",
                &format!("poll-{index}"),
                "Question?",
                &["One".into(), "Two".into()],
                false,
            )
            .unwrap();
    }
    let original = state.channel_poll(ORG, "text", "poll-0").unwrap();
    assert_eq!(
        state.create_channel_poll(
            ORG,
            "text",
            "overflow",
            "Question?",
            &["One".into(), "Two".into()],
            false
        ),
        Err(CoreError::CapacityExceeded)
    );
    assert_eq!(state.channel_poll(ORG, "text", "poll-0").unwrap(), original);
    assert_eq!(
        state.channel_poll(OTHER_ORG, "text", "poll-0"),
        Err(CoreError::OrganisationMismatch)
    );
    assert_eq!(
        state.channel_poll(ORG, "other", "poll-0"),
        Err(CoreError::PollNotFound)
    );
    state
        .switch_organisation(OTHER_ORG, [0x43; 32], HashSet::new(), 1)
        .unwrap();
    assert!(state.channel_polls.is_empty());
    assert_eq!(
        state.channel_poll(OTHER_ORG, "text", "poll-0"),
        Err(CoreError::PollNotFound)
    );
    state
        .create_channel_poll(
            OTHER_ORG,
            "text",
            "poll",
            "Question?",
            &["One".into(), "Two".into()],
            false,
        )
        .unwrap();
    assert!(state
        .switch_organisation("invalid", [0x43; 32], HashSet::new(), 1)
        .is_err());
    assert!(state.channel_polls.is_empty());
    assert_eq!(
        state.channel_poll(OTHER_ORG, "text", "poll"),
        Err(CoreError::TransportUnavailable)
    );
}
#[test]
fn failed_poll_creation_and_votes_do_not_burn_or_replace_ids() {
    let mut state = session();
    assert_eq!(
        state.create_channel_poll(ORG, "text", "poll", "Question?", &["One".into()], false),
        Err(CoreError::InvalidPoll)
    );
    assert!(state.channel_polls.is_empty());
    state
        .create_channel_poll(
            ORG,
            "text",
            "poll",
            "Question?",
            &["One".into(), "Two".into()],
            false,
        )
        .unwrap();
    assert_eq!(
        state.vote_channel_poll(ORG, "text", "poll", ORG, &[99]),
        Err(CoreError::InvalidPollVote)
    );
    assert_eq!(
        state.channel_poll(ORG, "text", "poll").unwrap().total_votes,
        0
    );
    state
        .vote_channel_poll(ORG, "text", "poll", ORG, &[1])
        .unwrap();
    state.clear_session();
    assert!(state.channel_polls.is_empty());
}
#[test]
fn iban_json_never_reflects_raw_account_in_request_response_or_errors() {
    let raw = "FR7612345678901234567890189";
    let request = json("redact_iban", &format!(r#", "raw_iban":"{raw}""#));
    let decoded = DesktopCommandRequest::from_json(&request).unwrap();
    assert!(!format!("{decoded:?}").contains(raw));
    assert!(!format!("{decoded}").contains(raw));
    let result = session().dispatch_command(&request);
    assert_eq!(
        result,
        DesktopCommandResponse::RedactedIban("FR76 **** **** **** **** ***0 189".into())
    );
    assert!(!format!("{result:?}").contains(raw));
    let error = session().dispatch_command(&request.replace("FR76", "fr76"));
    assert_eq!(
        error,
        DesktopCommandResponse::Error(DesktopCommandError::Core(CoreError::InvalidIban))
    );
    assert!(!format!("{error:?}").contains(raw));
    assert_eq!(
        session().dispatch_command(&request.replace(ORG, OTHER_ORG)),
        DesktopCommandResponse::Error(DesktopCommandError::Core(CoreError::OrganisationMismatch))
    );
}
#[test]
fn connector_url_json_is_org_fenced_and_metadata_only() {
    let request = json(
        "validate_connector_post_url",
        r#", "raw_url":"https://social.example.org:443/@member/42""#,
    );
    assert_eq!(
        session().dispatch_command(&request),
        DesktopCommandResponse::ConnectorPostUrl("https://social.example.org/@member/42".into())
    );
    assert_eq!(
        session().dispatch_command(&request.replace(ORG, OTHER_ORG)),
        DesktopCommandResponse::Error(DesktopCommandError::Core(CoreError::OrganisationMismatch))
    );
    assert_eq!(
        session().dispatch_command(&request.replace("https://", "http://")),
        DesktopCommandResponse::Error(DesktopCommandError::Core(CoreError::InvalidConnectorUrl))
    );
}

#[test]
fn preferences_six_json_routes_keep_org_fences_and_new_op_form() {
    let mut state = session();
    assert!(matches!(
        state.dispatch_command(&json("set_theme_mode", r#", "mode":"black""#)),
        DesktopCommandResponse::ThemeMode {
            mode: CoreThemeMode::RealBlack,
            ..
        }
    ));
    let DesktopCommandResponse::ShareableThemeCode(code) =
        state.dispatch_command(&json("export_shareable_theme", ""))
    else {
        panic!("theme code");
    };
    let import = json("import_shareable_theme", &format!(r#", "code":"{code}""#));
    let DesktopCommandResponse::ShareableTheme(theme) = state.dispatch_command(&import) else {
        panic!("theme");
    };
    assert_eq!(theme.id, "preset-real-black-oled");
    assert!(matches!(
        state.dispatch_command(&profile_json()),
        DesktopCommandResponse::UserProfile(_)
    ));
    let iam = json(
        "evaluate_channel_iam",
        r#", "channel_id":"text","rank":"moderator""#,
    );
    let DesktopCommandResponse::ChannelAccess(d) = state.dispatch_command(&iam) else {
        panic!("decision");
    };
    assert!(d.can_manage && d.can_create_poll && !d.can_manage_connectors && !d.can_join_voice);
    let save = save_json("pad", "text", "body");
    assert!(matches!(
        state.dispatch_command(&save),
        DesktopCommandResponse::DocsPad(_)
    ));
    assert!(matches!(
        state.dispatch_command(
            &json("set_theme_mode", r#", "mode":"light""#).replace("\"command\"", "\"op\"")
        ),
        DesktopCommandResponse::ThemeMode {
            mode: CoreThemeMode::Light,
            ..
        }
    ));
    for request in [
        json("set_theme_mode", r#", "mode":"black""#),
        import,
        json("export_shareable_theme", ""),
        profile_json(),
        iam,
        save,
    ] {
        assert_eq!(
            state.dispatch_command(&request.replacen(ORG, OTHER_ORG, 1)),
            DesktopCommandResponse::Error(DesktopCommandError::Core(
                CoreError::OrganisationMismatch
            ))
        );
    }
}
#[test]
fn preferences_unknown_duplicate_fields_and_alias_conflicts_are_transactional() {
    let mut state = session();
    state.dispatch_command(&profile_json());
    state.dispatch_command(&save_json("pad", "text", "body"));
    let before_theme = state.export_shareable_theme(ORG).unwrap();
    let before_profile = state.user_profile(ORG).unwrap();
    let before_doc = state.docs_pad(ORG, "pad").unwrap();
    for raw in [
        json("set_theme_mode", r#", "mode":"light","mode":"black""#),
        json("set_theme_mode", r#", "mode":"light","\u006dode":"black""#),
        json("set_theme_mode", r#", "mode":"light","extra":false"#),
        json("set_theme_mode", r#", "mode":1"#),
        profile_json().replace("\"rank\"", "\"role\""),
        json(
            "evaluate_channel_iam",
            r#", "channel_id":"text","rank":"owner","min_read_rank":"guest""#,
        ),
        json(
            "get_sound_pack",
            r#", "op":"set_theme_mode","mode":"light""#,
        ),
        json("clear_workspace_session", "").replace("\"command\"", "\"op\""),
        json("import_shareable_theme", r#", "code":"invalid""#),
    ] {
        assert!(
            matches!(
                state.dispatch_command(&raw),
                DesktopCommandResponse::Error(_)
            ),
            "schema refusal"
        );
        assert_eq!(state.export_shareable_theme(ORG).unwrap(), before_theme);
        assert_eq!(state.user_profile(ORG).unwrap(), before_profile);
        assert_eq!(state.docs_pad(ORG, "pad").unwrap(), before_doc);
    }
}
#[test]
fn theme_mode_switch_discards_custom_palette_without_changing_sound_preference() {
    let mut state = session();
    state.set_sound_pack(ORG, SoundPackId::Silent).unwrap();
    let theme = kodera_rs::curated_desktop_themes()[2].clone();
    let code = kodera_rs::encode_shareable_theme(&theme).unwrap();
    state.import_shareable_theme(ORG, &code).unwrap();
    assert_eq!(state.export_shareable_theme(ORG).unwrap(), code);
    assert!(state.import_shareable_theme(ORG, "bad").is_err());
    assert_eq!(state.export_shareable_theme(ORG).unwrap(), code);
    state.set_theme_mode(ORG, CoreThemeMode::Light).unwrap();
    let next =
        kodera_rs::decode_shareable_theme(&state.export_shareable_theme(ORG).unwrap()).unwrap();
    assert_eq!(next.base_mode, CoreThemeMode::Light);
    assert_eq!(state.sound_pack(ORG), Ok(SoundPackId::Silent));
}
#[test]
fn typed_profile_revalidates_public_fields_before_session_retention() {
    let mut state = session();
    state.dispatch_command(&profile_json());
    let before = state.user_profile(ORG).unwrap().unwrap();
    let mut invalid = before.clone();
    invalid.display_name = "bad\n".into();
    assert!(state.update_user_profile(ORG, invalid).is_err());
    assert_eq!(state.user_profile(ORG).unwrap(), Some(before));
}
#[test]
fn docs_typed_64kib_and_json_16kib_limits_are_separate_and_transactional() {
    let mut state = session();
    let body = "x".repeat(65_536);
    let d = state
        .save_docs_pad(ORG, "pad", "text", "Title", &body, "author")
        .unwrap();
    assert_eq!(d.markdown_body.len(), 65_536);
    let request = save_json("pad", "text", &body);
    assert!(request.len() > MAX_IPC_COMMAND_BYTES);
    assert_eq!(
        state.dispatch_command(&request),
        DesktopCommandResponse::Error(DesktopCommandError::RequestTooLarge)
    );
    let before = state.docs_pad(ORG, "pad").unwrap();
    assert!(state
        .save_docs_pad(ORG, "pad", "other", "Title", "body", "author")
        .is_err());
    assert!(state
        .save_docs_pad(ORG, "pad", "text", "Title", &"x".repeat(65_537), "author")
        .is_err());
    assert_eq!(state.docs_pad(ORG, "pad").unwrap(), before);
    assert_eq!(
        state
            .save_docs_pad(ORG, "pad", "text", "Next", "body", "author")
            .unwrap()
            .revision,
        2
    );
}
#[test]
fn docs_registry_capacity_replacements_and_failed_identity_do_not_leak() {
    let mut state = session();
    for i in 0..kodera_rs::MAX_DOCS_PADS {
        state
            .save_docs_pad(ORG, &format!("pad-{i}"), "text", "Title", "body", "author")
            .unwrap();
    }
    assert_eq!(
        state.save_docs_pad(ORG, "overflow", "text", "Title", "body", "author"),
        Err(CoreError::CapacityExceeded)
    );
    assert_eq!(state.docs_pads.len(), kodera_rs::MAX_DOCS_PADS);
    assert_eq!(
        state
            .save_docs_pad(ORG, "pad-0", "text", "Next", "body", "author")
            .unwrap()
            .revision,
        2
    );
    assert!(state
        .save_docs_pad(ORG, " bad", "text", "Title", "body", "author")
        .is_err());
    assert_eq!(state.docs_pads.len(), kodera_rs::MAX_DOCS_PADS);
}
#[test]
fn preference_teardown_and_failed_switch_erase_profile_theme_and_docs() {
    let mut state = session();
    state.dispatch_command(&profile_json());
    state.dispatch_command(&save_json("pad", "text", "body"));
    let code = kodera_rs::encode_shareable_theme(&kodera_rs::curated_desktop_themes()[2]).unwrap();
    state.import_shareable_theme(ORG, &code).unwrap();
    assert!(state
        .switch_organisation("invalid", [0; 32], Default::default(), 1)
        .is_err());
    assert!(
        state.custom_theme.is_none() && state.user_profile.is_none() && state.docs_pads.is_empty()
    );
    assert!(state.export_shareable_theme(ORG).is_err());
}
