# Docs pad export vectors

Status: Active

Each vector is three files: `<name>.meta` (one `key=value` per line: `pad_id`, `channel_id`, `title`, `revision`, `updated_by`), `<name>.body.txt` (the Markdown body, byte for byte) and `<name>.export.txt` (the exact export with front matter).

The Rust tests in `src/workspace_prefs.rs` and the Swift tests in `apps/ios/packages/KoderaDomain` read these same files, so both exports must match them byte for byte. Edit a vector only with both test suites.
