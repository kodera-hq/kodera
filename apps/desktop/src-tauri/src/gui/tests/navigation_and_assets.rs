use super::*;

#[test]
fn navigation_guard_admits_internal_assets_and_approved_origins_and_intercepts_deep_links() {
    let policy = DeepLinkAdmissionPolicy::kodera_default();
    let internal_root = format!("{INTERNAL_ASSET_ORIGIN}/");
    let internal_js = format!("{INTERNAL_ASSET_ORIGIN}/bootstrap.js");

    assert_eq!(
        validate_navigation_url(&internal_root, &policy, false).unwrap(),
        NavigationDecision::AllowInternalAsset {
            normalized_path: "/index.html".to_owned(),
        }
    );
    assert_eq!(
        validate_navigation_url(&internal_js, &policy, false).unwrap(),
        NavigationDecision::AllowInternalAsset {
            normalized_path: "/bootstrap.js".to_owned(),
        }
    );

    // Platform-exact WebView internal asset origin checks (BUG-0003):
    // Unix trusts `kodera-asset://localhost` ONLY; Windows trusts `https://kodera-asset.localhost` ONLY;
    // cleartext `http://kodera-asset.localhost` is rejected on EVERY OS.
    assert_eq!(
        validate_navigation_url_for_os("kodera-asset://localhost/", &policy, false, false).unwrap(),
        NavigationDecision::AllowInternalAsset {
            normalized_path: "/index.html".to_owned(),
        }
    );
    assert_eq!(
        validate_navigation_url_for_os(
            "https://kodera-asset.localhost/bootstrap.js",
            &policy,
            false,
            false
        ),
        Err(NavigationGuardError::UntrustedOrigin)
    );
    assert_eq!(
        validate_navigation_url_for_os(
            "https://kodera-asset.localhost/bootstrap.js",
            &policy,
            false,
            true
        )
        .unwrap(),
        NavigationDecision::AllowInternalAsset {
            normalized_path: "/bootstrap.js".to_owned(),
        }
    );
    assert_eq!(
        validate_navigation_url_for_os("kodera-asset://localhost/", &policy, false, true),
        Err(NavigationGuardError::UntrustedOrigin)
    );
    for is_win in [false, true] {
        for allow_dev in [false, true] {
            assert_eq!(
                validate_navigation_url_for_os(
                    "http://kodera-asset.localhost/",
                    &policy,
                    allow_dev,
                    is_win
                ),
                Err(NavigationGuardError::UntrustedOrigin)
            );
        }
    }
    assert_eq!(
        validate_navigation_url("http://kodera-asset.localhost/", &policy, false),
        Err(NavigationGuardError::UntrustedOrigin)
    );
    assert_eq!(
        validate_navigation_url("http://kodera-asset.localhost/", &policy, true),
        Err(NavigationGuardError::UntrustedOrigin)
    );
    #[cfg(not(target_os = "windows"))]
    assert_eq!(
        validate_navigation_url("https://kodera-asset.localhost/", &policy, false),
        Err(NavigationGuardError::UntrustedOrigin)
    );
    #[cfg(target_os = "windows")]
    assert_eq!(
        validate_navigation_url("kodera-asset://localhost/", &policy, false),
        Err(NavigationGuardError::UntrustedOrigin)
    );

    assert_eq!(
        validate_navigation_url("https://app.kodera.io/channels/general", &policy, false).unwrap(),
        NavigationDecision::AllowTrustedWebOrigin {
            origin: "https://app.kodera.io".to_owned(),
        }
    );
    assert_eq!(
        validate_navigation_url(
            "https://auth.kodera.io/realms/acme/protocol/openid-connect/auth",
            &policy,
            false
        )
        .unwrap(),
        NavigationDecision::AllowTrustedWebOrigin {
            origin: "https://auth.kodera.io".to_owned(),
        }
    );

    // Local Vite dev server requires explicit allow_dev_origin = true.
    assert_eq!(
        validate_navigation_url("http://localhost:5173/", &policy, false),
        Err(NavigationGuardError::UntrustedOrigin)
    );
    assert_eq!(
        validate_navigation_url("http://localhost:5173/", &policy, true).unwrap(),
        NavigationDecision::AllowTrustedWebOrigin {
            origin: "http://localhost:5173".to_owned(),
        }
    );

    // Valid kodera:// and matrix: deep links (including RFC 9207 percent-encoded `iss` query)
    // are intercepted rather than navigated directly.
    match validate_navigation_url("kodera://workspace/acme-ops/general", &policy, false).unwrap() {
        NavigationDecision::InterceptDeepLink(link) => {
            assert_eq!(link.canonical_uri(), "kodera://workspace/acme-ops/general");
        }
        other => panic!("expected InterceptDeepLink, got {other:?}"),
    }
    match validate_navigation_url(
            "kodera://auth/callback?code=authcode_abcdef012345&state=state_token_9876543210&iss=https%3A%2F%2Fauth.kodera.io%2Frealms%2Facme",
            &policy,
            false,
        )
        .unwrap()
        {
            NavigationDecision::InterceptDeepLink(_) => {}
            other => panic!("expected InterceptDeepLink for OIDC callback, got {other:?}"),
        }
}

#[test]
fn navigation_guard_fails_closed_on_malicious_schemes_traversal_and_external_hosts() {
    let policy = DeepLinkAdmissionPolicy::kodera_default();
    for dangerous in [
        "javascript:alert(1)",
        "JAVASCRIPT:alert(1)",
        "data:text/html,<script>alert(1)</script>",
        "file:///etc/passwd",
        "vbscript:msgbox(1)",
        "blob:https://app.kodera.io/uuid",
        "about:blank",
    ] {
        assert_eq!(
            validate_navigation_url(dangerous, &policy, true),
            Err(NavigationGuardError::DangerousScheme),
            "must block dangerous scheme {dangerous}"
        );
    }

    assert_eq!(
        validate_navigation_url("https://evil.example/phish", &policy, true),
        Err(NavigationGuardError::UntrustedOrigin)
    );
    assert_eq!(
        validate_navigation_url("https://app.kodera.io.evil.example/", &policy, true),
        Err(NavigationGuardError::UntrustedOrigin)
    );
    assert_eq!(
        validate_navigation_url("https://admin@app.kodera.io/", &policy, true),
        Err(NavigationGuardError::EmbeddedCredentials)
    );
    assert_eq!(
        validate_navigation_url(
            &format!("{INTERNAL_ASSET_ORIGIN}/../tauri.conf.json"),
            &policy,
            true
        ),
        Err(NavigationGuardError::PathTraversal)
    );
    assert_eq!(
        validate_navigation_url(
            &format!("{INTERNAL_ASSET_ORIGIN}/%2e%2e/secret"),
            &policy,
            true
        ),
        Err(NavigationGuardError::PathTraversal)
    );
    assert!(matches!(
        validate_navigation_url(
            "kodera://workspace/acme/general?redirect_uri=https://evil.example",
            &policy,
            false
        ),
        Err(NavigationGuardError::RejectedDeepLink(_))
    ));
}

#[test]
fn custom_asset_protocol_attaches_verified_csp_and_blocks_traversal() {
    let csp = verify_embedded_tauri_conf_csp().unwrap();
    let index = resolve_asset_response(None, "/", &csp);
    assert_eq!(index.status, 200);
    assert_eq!(index.content_type, "text/html; charset=utf-8");
    assert_eq!(index.csp_header, csp);
    let html = core::str::from_utf8(&index.body).unwrap();
    assert!(html.contains("<title>Kodera</title>"));
    assert!(!html.contains("<style"));

    let traversal = resolve_asset_response(None, "/../../Cargo.toml", &csp);
    assert_eq!(traversal.status, 400);
}

#[test]
fn spa_route_fallback_serves_bundled_index_html_and_returns_404_for_missing_assets() {
    let csp = verify_embedded_tauri_conf_csp().unwrap();
    let scratch = ScopedTempDir::new("spa-fallback");
    let dist = scratch.path().join("web");
    fs::create_dir_all(dist.join("assets")).unwrap();
    let spa_html = b"<!doctype html><html><head><title>Kodera SPA</title></head><body><div id=\"root\"></div></body></html>";
    fs::write(dist.join("index.html"), spa_html).unwrap();
    fs::write(dist.join("assets/main.js"), b"console.log('kodera');").unwrap();

    let static_js = resolve_asset_response(Some(&dist), "/assets/main.js", &csp);
    assert_eq!(static_js.status, 200);
    assert_eq!(static_js.content_type, "text/javascript; charset=utf-8");
    assert_eq!(static_js.csp_header, csp);
    assert_eq!(static_js.body, b"console.log('kodera');");

    for spa_route in ["/login", "/onboarding", "/channels/general"] {
        let resp = resolve_asset_response(Some(&dist), spa_route, &csp);
        assert_eq!(resp.status, 200, "SPA route {spa_route} must return 200");
        assert_eq!(resp.content_type, "text/html; charset=utf-8");
        assert_eq!(resp.csp_header, csp);
        assert_eq!(resp.body, spa_html);
    }

    for missing_asset in ["/missing.js", "/assets/absent.css", "/bootstrap.js"] {
        let miss = resolve_asset_response(Some(&dist), missing_asset, &csp);
        assert_eq!(
            miss.status, 404,
            "missing static asset {missing_asset} must return 404"
        );
        assert_eq!(miss.csp_header, csp);
    }
}

#[test]
fn bundle_asset_discovery_resolves_macos_linux_appimage_and_windows_layouts() {
    let scratch = ScopedTempDir::new("bundle-discovery");

    // 1. macOS `.app`: Contents/MacOS/kodera-desktop -> Contents/Resources/web/index.html
    let mac_exe = scratch
        .path()
        .join("Kodera.app/Contents/MacOS/kodera-desktop");
    let mac_web = scratch.path().join("Kodera.app/Contents/Resources/web");
    fs::create_dir_all(mac_exe.parent().unwrap()).unwrap();
    fs::create_dir_all(&mac_web).unwrap();
    fs::write(mac_web.join("index.html"), b"<!doctype html>").unwrap();
    let found_mac =
        discover_frontend_dist_from_context(None, None, Some(&mac_exe), None, false).unwrap();
    assert_eq!(
        fs::canonicalize(found_mac).unwrap(),
        fs::canonicalize(&mac_web).unwrap()
    );

    // 2. Linux `.deb`: /usr/bin/kodera-desktop -> /usr/share/kodera-desktop/web/index.html
    let deb_exe = scratch.path().join("deb-root/usr/bin/kodera-desktop");
    let deb_web = scratch.path().join("deb-root/usr/lib/Kodera/web");
    fs::create_dir_all(deb_exe.parent().unwrap()).unwrap();
    fs::create_dir_all(&deb_web).unwrap();
    fs::write(deb_web.join("index.html"), b"<!doctype html>").unwrap();
    let found_deb =
        discover_frontend_dist_from_context(None, None, Some(&deb_exe), None, false).unwrap();
    assert_eq!(
        fs::canonicalize(found_deb).unwrap(),
        fs::canonicalize(&deb_web).unwrap()
    );

    // 3. Linux `.AppImage` via `$APPDIR/usr/share/kodera-desktop/web/index.html`
    let appdir = scratch.path().join("AppDir");
    let appimage_web = appdir.join("usr/lib/Kodera/web");
    fs::create_dir_all(&appimage_web).unwrap();
    fs::write(appimage_web.join("index.html"), b"<!doctype html>").unwrap();
    let found_appimage =
        discover_frontend_dist_from_context(None, Some(&appdir), None, None, false).unwrap();
    assert_eq!(
        fs::canonicalize(found_appimage).unwrap(),
        fs::canonicalize(&appimage_web).unwrap()
    );

    // 4. Windows `.msi` / NSIS: Program Files/Kodera/kodera-desktop.exe -> Program Files/Kodera/web/index.html
    let win_exe = scratch.path().join("win-install/Kodera/kodera-desktop.exe");
    let win_web = scratch.path().join("win-install/Kodera/web");
    fs::create_dir_all(&win_web).unwrap();
    fs::write(win_web.join("index.html"), b"<!doctype html>").unwrap();
    let found_win =
        discover_frontend_dist_from_context(None, None, Some(&win_exe), None, false).unwrap();
    assert_eq!(
        fs::canonicalize(found_win).unwrap(),
        fs::canonicalize(&win_web).unwrap()
    );
}
