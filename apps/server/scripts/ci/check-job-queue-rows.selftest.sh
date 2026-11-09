#!/usr/bin/env bash
# Proves the job-queue row check can fail.
#
# The case that matters is the run that never entered tests/job_queue: pytest
# exits 0 and the report simply lacks the rows. The others pin what counts as a
# call report: a skip does not, a row reported twice or under another module
# does not, and an outcome that contradicts the row's state does not; and a row
# counts only with its self-test proofs passed, and the real queue's proofs
# (§9.2) are required too: every mutant row's runner case, the flag registry,
# the unset JOB_QUEUE_EXTRA_BINDINGS, and the settings-module refusal check with
# its mutations and its static check. A settings package, and each module inside
# it, is a settings module the check requires a report for. Each case also names
# the sentence it expects, so a fixture the check cannot read passes none.

set -euo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
script="$here/check-job-queue-rows.py"
unset JOB_QUEUE_EXTRA_BINDINGS

[ -f "$script" ] || { echo "self-test FAILED: $script is missing" >&2; exit 1; }

work="$(mktemp -d "${TMPDIR:-/tmp}/job-queue-rows-selftest.XXXXXX")"
trap 'rm -rf "$work"' EXIT

module="tests.job_queue.test_job_queue_acceptance"
xfail_row="$module\" name=\"test_a3_01_first"
pass_row="$module\" name=\"test_a3_02_second"

# fixture <name> <inventory body> <testcase elements> [self-test elements]: a root with an
# inventory, one mutant row, the settings modules dev and test, and a report. The self-test
# elements default to every proof the two rows and the mutant row need, passed.
fixture() {
  mkdir -p "$work/$1/tests/job_queue" "$work/$1/config/settings"
  printf '%s\n' "$2" > "$work/$1/tests/job_queue/acceptance.toml"
  printf '[[mutant]]\nflag = "f1"\n' > "$work/$1/tests/job_queue/mutants.toml"
  touch "$work/$1/config/settings/__init__.py" "$work/$1/config/settings/dev.py" \
    "$work/$1/config/settings/test.py"
  printf '<?xml version="1.0" encoding="utf-8"?>\n<testsuites><testsuite name="pytest">%s</testsuite></testsuites>\n' \
    "$3${4-$proofs}" > "$work/$1/junit.xml"
}

# proof <name> [child element]: one test case of the self-test module.
proof() {
  printf '<testcase classname="tests.job_queue.test_job_queue_selftest" name="%s">%s</testcase>' "$1" "${2:-}"
}

# refused <name> [child element]: one test case of the settings-module refusal check.
refused() {
  printf '<testcase classname="tests.test_job_queue_flags_refused" name="%s">%s</testcase>' "$1" "${2:-}"
}

# control <name>: one test case of the direct mutant-control checks.
control() {
  printf '<testcase classname="tests.test_job_queue_mutant_controls" name="%s"/>' "$1"
}

# expect <exit> <fixture> <label> [sentence]: the check's exit status on that fixture and, for a
# failure, the sentence it must print, so that a fixture the check cannot read never passes a case.
expect() {
  local want="$1" name="$2" label="$3" sentence="${4:-}" got=0 output
  output="$(python3 "$script" --root "$work/$name" --junit "$work/$name/junit.xml" 2>&1)" || got=$?
  if [ "$got" -ne "$want" ]; then
    echo "self-test FAILED: '$label' expected exit $want, got $got" >&2
    printf '%s\n' "$output" >&2
    exit 1
  fi
  if [ -n "$sentence" ] && ! grep -qF -- "$sentence" <<< "$output"; then
    echo "self-test FAILED: '$label' did not print: $sentence" >&2
    printf '%s\n' "$output" >&2
    exit 1
  fi
  printf '  ok  %-44s exit %s\n' "$label" "$got"
}

echo "check-job-queue-rows self-test"

inventory='[[test]]
id = "A3-01"
function = "test_a3_01_first"
state = "xfail"

[[test]]
id = "A3-02"
function = "test_a3_02_second"
state = "pass"'

xfailed="<testcase classname=\"$xfail_row\"><skipped type=\"pytest.xfail\" message=\"gap\"/></testcase>"
passed="<testcase classname=\"$pass_row\"/>"
other="<testcase classname=\"tests.test_other\" name=\"test_other\"/>"

broken="test_every_acceptance_test_fails_a_broken_queue_with_its_exact_message"
deletion="test_deleting_the_named_assertion_changes_how_the_permissive_queue_fails"
mutant_rows="test_every_mutant_row_names_an_owning_test_and_its_own_exact_message"
# Every proof but the deletion of A3-02's named assertion, which each proof case supplies itself.
some_proofs="$(proof "${broken}[A3-01-permissive]")$(proof "${broken}[A3-01-inert]")"
some_proofs+="$(proof "${broken}[A3-02-permissive]")$(proof "${broken}[A3-02-inert]")"
some_proofs+="$(proof "${deletion}[A3-01]")$(proof "$mutant_rows")"
runner="test_every_mutant_flag_is_caught_by_its_owning_test_on_the_real_queue"
registered="test_every_mutant_row_has_a_registered_flag_and_nothing_else_is_registered"
no_extra="test_no_binding_outside_the_repository_stands_in_for_the_queue"
no_module="test_no_settings_module_but_test_can_enable_a_mutant_flag"
refusal_proofs=(
  test_the_refusal_check_fails_a_settings_module_that_reads_its_flags_from_input
  test_the_refusal_check_fails_a_settings_module_that_enables_flags_by_itself
  test_the_refusal_check_fails_a_settings_module_that_does_not_start
  test_no_module_under_config_but_test_names_the_mutant_settings
  test_the_static_check_fails_a_module_that_names_the_mutant_settings
  test_the_settings_walk_finds_a_settings_package_and_the_modules_inside_it
)
real_proofs="$(proof "${runner}[f1]")$(proof "$registered")$(proof "$no_extra")"
real_proofs+="$(refused "${no_module}[config.settings.dev]")"
for refusal_proof in "${refusal_proofs[@]}"; do
  real_proofs+="$(refused "$refusal_proof")"
done
control_proofs=(
  test_custom_profiles_cannot_enable_queue_controls
  test_direct_settings_assignment_cannot_spoof_the_test_profile
  test_test_profile_permission_requires_true_and_matching_identity
  test_actual_test_profile_allows_overrides_and_revokes_permission
  test_control_proof_rejects_each_permission_weakening
  test_runtime_controls_refuse_invalid_flags_and_concurrent_activation
  test_database_controls_refuse_foreign_snapshots_and_unknown_mutants
  test_pristine_guard_comparison_reports_missing_and_disarmed_guards
)
for control_proof in "${control_proofs[@]}"; do
  real_proofs+="$(control "$control_proof")"
done
isolation_proofs=(
  test_each_transaction_omission_is_caught
  test_default_setting_substitution_is_caught
  test_cached_preflight_substitution_is_caught
  test_isolation_rewrite_substitution_is_caught
  test_validation_and_cleanup_reordering_are_caught
  test_failed_isolation_read_never_assumes_read_committed
)
isolation() {
  printf '<testcase classname="tests.test_job_queue_isolation" name="%s"/>' "$1"
}
for isolation_proof in "${isolation_proofs[@]}"; do
  real_proofs+="$(isolation "$isolation_proof")"
done
some_proofs+="$real_proofs"
proofs="$some_proofs$(proof "${deletion}[A3-02]")"

fixture complete "$inventory" "$xfailed$passed$other"
expect 0 complete complete "2 of 2 job-queue acceptance rows produced a call report"
expect 0 complete "complete, counting every proof" "31 self-test proofs required for them"

for isolation_proof in "${isolation_proofs[@]}"; do
  fixture isolation-missing "$inventory" "$xfailed$passed" "${proofs/"$(isolation "$isolation_proof")"/}"
  expect 1 isolation-missing "isolation proof missing: $isolation_proof" \
    "the check $isolation_proof reported nothing, not one pass"
done

fixture runner-missing "$inventory" "$xfailed$passed" "${proofs/"$(proof "${runner}[f1]")"/}"
expect 1 runner-missing "a mutant row's runner case missing" \
  "the self-test ${runner}[f1] reported nothing, not one pass"

fixture runner-skipped "$inventory" "$xfailed$passed" \
  "${proofs/"$(proof "${runner}[f1]")"/$(proof "${runner}[f1]" '<skipped type="pytest.skip" message="x"/>')}"
expect 1 runner-skipped "a mutant row's runner case skipped" \
  "the self-test ${runner}[f1] reported ['skip'], not one pass"

fixture registry-missing "$inventory" "$xfailed$passed" "${proofs/"$(proof "$registered")"/}"
expect 1 registry-missing "the flag registry check missing" \
  "the self-test $registered reported nothing, not one pass"

fixture no-extra-missing "$inventory" "$xfailed$passed" "${proofs/"$(proof "$no_extra")"/}"
expect 1 no-extra-missing "the unset-bindings check missing" \
  "the self-test $no_extra reported nothing, not one pass"

fixture module-unchecked "$inventory" "$xfailed$passed" \
  "${proofs/"$(refused "${no_module}[config.settings.dev]")"/}"
expect 1 module-unchecked "a settings module left unchecked" \
  "the check ${no_module}[config.settings.dev] reported nothing, not one pass"

fixture module-added "$inventory" "$xfailed$passed$other"
touch "$work/module-added/config/settings/production.py"
expect 1 module-added "a settings module added and never checked" \
  "the check ${no_module}[config.settings.production] reported nothing, not one pass"

# A settings package is a settings module too, and so is each module inside it.
fixture package-added "$inventory" "$xfailed$passed$other"
mkdir "$work/package-added/config/settings/production"
touch "$work/package-added/config/settings/production/__init__.py"
expect 1 package-added "a settings package added and never checked" \
  "the check ${no_module}[config.settings.production] reported nothing, not one pass"

in_package="$(refused "${no_module}[config.settings.production]")"
fixture package-module-added "$inventory" "$xfailed$passed$other" "$proofs$in_package"
# Two directories down, so that a walk of one level only fails here.
mkdir -p "$work/package-module-added/config/settings/production/regions"
touch "$work/package-module-added/config/settings/production/__init__.py" \
  "$work/package-module-added/config/settings/production/regions/paris.py"
expect 1 package-module-added "a module two levels inside a settings package never checked" \
  "the check ${no_module}[config.settings.production.regions.paris] reported nothing, not one pass"

# Only the module config.settings.test is left out: a test.py inside another package, and a
# module inside a test package, are settings modules.
fixture nested-test "$inventory" "$xfailed$passed$other" "$proofs$in_package"
mkdir "$work/nested-test/config/settings/production"
touch "$work/nested-test/config/settings/production/__init__.py" \
  "$work/nested-test/config/settings/production/test.py"
expect 1 nested-test "a test.py inside a settings package never checked" \
  "the check ${no_module}[config.settings.production.test] reported nothing, not one pass"

fixture test-package-module "$inventory" "$xfailed$passed$other"
mkdir "$work/test-package-module/config/settings/test"
touch "$work/test-package-module/config/settings/test/__init__.py" \
  "$work/test-package-module/config/settings/test/extra.py"
expect 1 test-package-module "a module inside a test settings package never checked" \
  "the check ${no_module}[config.settings.test.extra] reported nothing, not one pass"

in_package+="$(refused "${no_module}[config.settings.production.regions.paris]")"
fixture package-checked "$inventory" "$xfailed$passed$other" "$proofs$in_package"
mkdir -p "$work/package-checked/config/settings/production/regions"
touch "$work/package-checked/config/settings/production/__init__.py" \
  "$work/package-checked/config/settings/production/regions/paris.py"
expect 0 package-checked "a settings package and its module checked" \
  "33 self-test proofs required for them"

for refusal_proof in "${refusal_proofs[@]}"; do
  fixture "missing-$refusal_proof" "$inventory" "$xfailed$passed" \
    "${proofs/"$(refused "$refusal_proof")"/}"
  expect 1 "missing-$refusal_proof" "the refusal proof $refusal_proof missing" \
    "the check $refusal_proof reported nothing, not one pass"
done

fixture extra-bindings "$inventory" "$xfailed$passed$other"
JOB_QUEUE_EXTRA_BINDINGS=reference expect 1 extra-bindings "JOB_QUEUE_EXTRA_BINDINGS set" \
  "FAILED: JOB_QUEUE_EXTRA_BINDINGS is set in the job that checks the rows"

fixture no-mutants "$inventory" "$xfailed$passed$other"
rm "$work/no-mutants/tests/job_queue/mutants.toml"
expect 1 no-mutants "no mutant rows file" "cannot read the mutant rows"

fixture empty-mutants "$inventory" "$xfailed$passed$other"
printf 'mutant = []\n' > "$work/empty-mutants/tests/job_queue/mutants.toml"
expect 1 empty-mutants "a mutant file with no row" "lists no mutant row"

fixture ignored "$inventory" "$other"
expect 1 ignored "directory ignored: no row reported" "A3-01 (test_a3_01_first) has 0 reports, not 1"

fixture one-missing "$inventory" "$xfailed$other"
expect 1 one-missing "one row deselected" "A3-02 (test_a3_02_second) has 0 reports, not 1"

fixture skipped "$inventory" \
  "$xfailed<testcase classname=\"$pass_row\"><skipped type=\"pytest.skip\" message=\"no db\"/></testcase>"
expect 1 skipped "a row skipped at setup" "A3-02 reported skip, but its state is pass"

fixture failed "$inventory" \
  "$xfailed<testcase classname=\"$pass_row\"><failure message=\"boom\"/></testcase>"
expect 1 failed "a pass row failed" "A3-02 reported failure, but its state is pass"

fixture errored "$inventory" \
  "<testcase classname=\"$xfail_row\"><error message=\"setup\"/></testcase>$passed"
expect 1 errored "an xfail row errored" "A3-01 reported error, but its state is xfail"

fixture teardown-error "$inventory" \
  "<testcase classname=\"$xfail_row\"><skipped type=\"pytest.xfail\" message=\"gap\"/><error message=\"teardown\"/></testcase>$passed"
expect 1 teardown-error "an xfail row with a teardown error" "A3-01 reported error, but its state is xfail"

fixture xpassed "$inventory" "<testcase classname=\"$xfail_row\"/>$passed"
expect 1 xpassed "an xfail row passed" "A3-01 reported pass, but its state is xfail"

fixture pass-xfailed "$inventory" \
  "$xfailed<testcase classname=\"$pass_row\"><skipped type=\"pytest.xfail\" message=\"x\"/></testcase>"
expect 1 pass-xfailed "a pass row xfailed" "A3-02 reported xfail, but its state is pass"

fixture twice "$inventory" "$xfailed$xfailed$passed"
expect 1 twice "a row reported twice" "A3-01 (test_a3_01_first) has 2 reports, not 1"

fixture elsewhere "$inventory" \
  "$xfailed<testcase classname=\"tests.copy\" name=\"test_a3_02_second\"/>"
expect 1 elsewhere "a row reported under another module" "A3-02 (test_a3_02_second) has 0 reports, not 1"

fixture proof-deselected "$inventory" "$xfailed$passed" "$some_proofs"
expect 1 proof-deselected "the self-test module deselected" \
  "the self-test ${deletion}[A3-02] reported nothing, not one pass"

fixture inert-proof-deselected "$inventory" "$xfailed$passed" "${proofs/"$(proof "${broken}[A3-01-inert]")"/}"
expect 1 inert-proof-deselected "a row's inert-queue proof deselected" \
  "the self-test ${broken}[A3-01-inert] reported nothing, not one pass"

fixture mutant-proof-deselected "$inventory" "$xfailed$passed" "${proofs/"$(proof "$mutant_rows")"/}"
expect 1 mutant-proof-deselected "the mutant-row check deselected" \
  "the self-test $mutant_rows reported nothing, not one pass"

fixture proof-skipped "$inventory" "$xfailed$passed" \
  "$some_proofs$(proof "${deletion}[A3-02]" '<skipped type="pytest.skip" message="x"/>')"
expect 1 proof-skipped "a proof skipped" \
  "the self-test ${deletion}[A3-02] reported ['skip'], not one pass"

fixture proof-failed "$inventory" "$xfailed$passed" \
  "$some_proofs$(proof "${deletion}[A3-02]" '<failure message="x"/>')"
expect 1 proof-failed "a proof failed" \
  "the self-test ${deletion}[A3-02] reported ['failure'], not one pass"

fixture empty-inventory "test = []" "$xfailed$passed"
expect 1 empty-inventory "an inventory with no row" "lists no row"

fixture no-report "$inventory" "$xfailed$passed"
rm "$work/no-report/junit.xml"
expect 1 no-report "no JUnit report written" "cannot read the JUnit report"

fixture broken-report "$inventory" "$xfailed$passed"
printf '<testsuites><testsuite>' > "$work/broken-report/junit.xml"
expect 1 broken-report "a truncated JUnit report" "cannot read the JUnit report"

for control_proof in "${control_proofs[@]}"; do
  fixture "missing-$control_proof" "$inventory" "$xfailed$passed" \
    "${proofs/"$(control "$control_proof")"/}"
  expect 1 "missing-$control_proof" "the control proof $control_proof missing" \
    "the check $control_proof reported nothing, not one pass"
done

echo "check-job-queue-rows self-test passed"
