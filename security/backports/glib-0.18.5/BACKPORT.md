# GLib iterator source backport

Status: Integrated source override; optimized Linux regression and negative runtime controls pending.

This directory preserves all 121 regular files from the exact `glib 0.18.5` registry archive. Its SHA-256, `233daaf6e83ae6a12a52055f568f9d7cf4671dabb78ff9560ab6da230ce00ee5`, matched the reviewed baseline Cargo.lock before materialization. Every archive member also matched the existing extracted cache; no global cache was modified. The original MIT `LICENSE` and `COPYRIGHT`, Cargo manifests, upstream README and `.cargo_vcs_info.json` remain unchanged.

Only `src/variant_iter.rs` changes within the upstream files: the exact two-line mutable out-pointer correction from [gtk-rs-core#1343](https://github.com/gtk-rs/gtk-rs-core/pull/1343), merged as `05dff0ee696f9bcd8617cd48c4b812d046d440cb`. `upstream.patch` records that change. The added `tests/variant_str_iter_out_pointer.rs` reads actual forward/reverse/mixed iterator values, UTF-8, empty arrays and exhaustion. Counting elements alone would not force the affected C-string path.

`provenance.json` records each original package file hash, the exact original and backported source identities, the added regression hash, and the integrated source-file manifest digest. `verify.py` refuses changed/missing/unexpected files, altered notices, a different source patch, version changes and a mismatched root source override/lock entry. It also refuses the original source and a reverted immutable out-argument in memory. The optional `--selftest` also checks one synthetic optimized-artifact selection and seven refusal cases, removing its tiny fixtures immediately. Those integrity/selector controls do not count as optimized runtime mutant kills.

## Same-version dependency identity

Root Cargo.toml explicitly excludes this package from workspace membership and overrides only crates.io `glib` to this path. Cargo.lock retains version `0.18.5` and the same dependency list, removing only its registry source/checksum because the selected package is now local. No package resolution, fake version bump or broader dependency update was performed.

GTK 0.18 requires GLib 0.18. Adding GLib 0.20 directly would leave the vulnerable transitive crate present. This reviewed same-version source has a distinct integrated source-manifest hash; it is not the original registry archive under a new label. Version-only scanners can still flag [GHSA-wrw7-89jp-8q8g](https://github.com/advisories/GHSA-wrw7-89jp-8q8g), which lists versions below 0.20 as affected. The Cargo advisory gate queries this baseline and binds only RUSTSEC-2024-0429 and its GHSA-wrw7-89jp-8q8g alias to this verified correction in security/cargo-advisory-allowlist.json. Every other advisory remains blocking.

## Source verification

The normal CI integrity check needs no registry cache or Python dependencies:

```sh
PYTHONDONTWRITEBYTECODE=1 python3 security/backports/glib-0.18.5/verify.py --selftest
```

When the original registry archive and cache are already available, additionally pass `--archive /path/to/glib-0.18.5.crate --cached-source /path/to/glib-0.18.5`. Archive authentication is against the recorded baseline registry checksum; the current lock correctly identifies the selected local source instead.

## Hosted Linux CI qualification

The reusable Rust/desktop workflow verifies source and source-only refusal fixtures, then calls `scripts/ci/qualify-glib-iterator.py --execute` for the checked-out revision. This helper requires hosted Linux, the existing GTK/GLib toolchain and at least 21 GiB available; it retains the shared Cargo target and committed lock. Its process-group early-stop guard is 20.25 GiB. It builds only the patched library through the locked workspace graph and retains Cargo JSON output:

```sh
cargo build --locked --offline --release -p glib --lib \
  --message-format=json > "$RUNNER_TEMP/glib-release-artifacts.json"
```

This uses only the existing workspace graph and does not compile the vendored crate as a standalone workspace or add its development dependencies. The previously proposed direct `cargo test --locked --release -p glib --test ...` needs adjustment: this explicitly excluded vendored crate has no standalone Cargo.lock, and its own development dependencies (`criterion`, `gir-format-check`, `tempfile`, `trybuild2`) are absent from the workspace lock. Running its standalone tests would require a new resolution. Do not silently add those dependencies or remove `--locked`.

Instead select the exact backported optimized `.rlib` from that build:

```sh
PYTHONDONTWRITEBYTECODE=1 python3 security/backports/glib-0.18.5/verify.py \
  --cargo-messages "$RUNNER_TEMP/glib-release-artifacts.json" \
  --target-dir "$CARGO_TARGET_DIR" --print-rlib
```

The selector requires the candidate's exact manifest/source path, release optimization level 3, a non-test library, exactly one existing `.rlib`, and containment in the job's declared shared target. It refuses an arbitrary glob that could select a stale registry library. Without `--print-rlib`, it emits the artifact path and SHA-256 for evidence.

Feed that returned path into a structured `rustc` invocation using the same toolchain and target:

```text
rustc --edition=2021 --test security/backports/glib-0.18.5/tests/variant_str_iter_out_pointer.rs
  -C opt-level=3 -L dependency=<selected-rlib-directory> --extern glib=<selected-rlib>
  -o <owned-runner-temporary-test-binary>
```

The helper executes that owned test binary with `--exact variant_str_iter_out_pointer_optimized_regression` and requires exactly one passing, non-ignored test. It then compiles a separate test source with a deliberately wrong expected first value, against the same exact backported library, and requires an executed assertion failure with that sentinel. Compiler failures, ignored/zero tests, crashes and timeouts cannot pass this assertion-oracle gate. The helper carries native link-search paths from Cargo build-script messages into the direct rustc invocation. Retain the exact rustc/Cargo versions, source-manifest digest, build flags/profile, selected library hash and exit/results. No GUI launch is needed for this iterator test.

For negative controls, use isolated CI source copies, never the global Cargo cache: restore both original out-pointer lines, then separately keep the mutable binding but revert only the FFI argument to `&p`. Rebuild each exact control with the same optimized profile and select its newly produced library through Cargo output; do not reuse the positive library. The production source verifier must refuse those controls, so a dedicated adversarial harness must bind each expected mutant hash explicitly rather than suppressing the production integrity gate. Also change one expected value in the test as an oracle control, then restore it for the positive run.

Only an executed assertion/crash/nonzero runtime result qualifies as a killed vulnerable mutant. Compilation failure, timeout, skipped test or an optimized vulnerable control that happens to pass must be reported honestly. Undefined behavior can depend on compiler/platform; the upstream mutable out-pointer safety correction remains the source rationale if a particular compiler does not reproduce the old failure. No optimized test or build was run during this source-only integration.

The current seven-minute step leaves the existing fifteen-minute job limit and all prior guards unchanged. Its command bounds are 240 seconds for the library build, 60 seconds for each test compilation, 15 seconds for each binary and five seconds for each version query, approximately 400 seconds plus small integrity/cleanup overhead. The measured baseline Rust/desktop job was 234 seconds; the combined estimate is below eleven minutes, pending actual hosted measurement. Positive and wrong-value-oracle evidence are written to the runner temporary evidence JSON and job log; temporary test binaries are removed. Vulnerable runtime controls remain explicitly unexecuted pending a separate isolated, locked-source qualification design and time budget.

The CI path planner includes both this backport directory and the qualification helper, with separate source-only self-tests, so later source-only corrections do not silently skip Rust qualification.
