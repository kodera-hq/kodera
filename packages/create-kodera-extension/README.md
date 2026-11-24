# create-kodera-extension

Status: Local pre-release package; not published to a registry

A zero-dependency Node CLI generator for Kodera webhook, slash-command, and sandboxed widget (`kodera.widget.v1`) starter extensions. Its `engines` range is `^22.22.2 || ^24.15.0 || >=26.0.0`. Runtime execution uses only the Node standard library; no third-party dependency install is needed to run the checked-out executable.

```sh
node packages/create-kodera-extension/bin/create-kodera-extension.mjs --selftest
node packages/create-kodera-extension/bin/create-kodera-extension.mjs \
  --slug incident-triage --commands triage --widgets incident-card --dry-run
```

## Security and filesystem invariants

- **Strict input validation:** `--slug`, `--commands`, and `--widgets` require canonical lowercase kebab-case identifiers.
- **Zero secret persistence:** secret-bearing flags (`--secret`, `--signing-secret`, `--token`, `--api-key`, `--private-key`, `--env-file`) and `.env` output paths are refused immediately (`SECRET_FLAG_REFUSED`, `SECRET_PATH_REFUSED`).
- **Path containment:** relative `--output-dir` values containing `..` segments or symbolic links are refused (`PATH_TRAVERSAL_REFUSED`, `SYMLINK_TARGET_REFUSED`), and non-empty target directories are never overwritten (`NON_EMPTY_DIRECTORY`).
- **Deterministic permissions:** generated directories use mode `0755` and UTF-8 starter files (`package.json`, `kodera-extension.json`, `src/index.mjs`, `test/extension.test.mjs`, `README.md`) use mode `0644`.

## Generated starter layout

Every scaffolded starter is labelled `Status: Reference implementation` with a reserved RFC 2606/6761 documentation `webhookUrl` (`https://extensions.example.invalid/hooks/<slug>`), constant-time HMAC-SHA256 verification via `@kodera/extension-sdk`, a declarative `kodera.widget.v1` card builder, and an in-memory `node:test` suite exercising valid deliveries, forged signatures, and `widget.action` callbacks.
