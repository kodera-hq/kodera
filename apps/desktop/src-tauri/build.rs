#![forbid(unsafe_code)]

use std::fs;
use std::path::Path;

fn assert_magic(rel_path: &str, expected_prefix: &[u8]) {
    println!("cargo:rerun-if-changed={rel_path}");
    let path = Path::new(rel_path);
    let bytes = fs::read(path).unwrap_or_else(|err| {
        panic!("missing or unreadable desktop bundle asset `{rel_path}`: {err}")
    });
    assert!(
        bytes.starts_with(expected_prefix),
        "desktop bundle asset `{rel_path}` has an invalid binary header"
    );
}

fn assert_utf8_json(rel_path: &str) {
    println!("cargo:rerun-if-changed={rel_path}");
    let text = fs::read_to_string(rel_path)
        .unwrap_or_else(|err| panic!("missing or unreadable `{rel_path}`: {err}"));
    let trimmed = text.trim();
    assert!(
        trimmed.starts_with('{') && trimmed.ends_with('}'),
        "`{rel_path}` must be a JSON object"
    );
}

fn main() {
    assert_utf8_json("tauri.conf.json");
    assert_utf8_json("capabilities/default.json");

    const PNG_MAGIC: &[u8] = b"\x89PNG\r\n\x1a\n";
    assert_magic("icons/32x32.png", PNG_MAGIC);
    assert_magic("icons/128x128.png", PNG_MAGIC);
    assert_magic("icons/128x128@2x.png", PNG_MAGIC);
    assert_magic("icons/icon.png", PNG_MAGIC);
    assert_magic("icons/icon.icns", b"icns");
    assert_magic("icons/icon.ico", &[0x00, 0x00, 0x01, 0x00]);
}
