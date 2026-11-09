#!/usr/bin/env bash
# Weakens each positive assertion of the job-kind check and requires a NAMED
# case of its self-test to notice.
#
# The self-test proves the check can refuse a broken pair of documents. It does
# not prove the check is still reading the documents at all: every case there
# would pass with a rule deleted, as long as some other rule happens to catch
# the same fixture. So each rule is removed here one at a time, and the case
# that caught it is printed — "the suite went red" is not evidence that the
# intended case is what went red, and two of this repository's checks were found
# to have rules no case owned.

set -uo pipefail

here="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
checker="$here/check_job_kind_catalogue.py"
selftest="$here/check-job-kind-catalogue.selftest.sh"
python_command="${PYTHON:-python3}"

work="$(mktemp -d "${TMPDIR:-/tmp}/job-kind-mutations.XXXXXX")"
trap 'rm -r -- "$work"' EXIT
cp "$checker" "$work/pristine.py"
# The self-test stays where it is and is pointed at a mutated COPY through
# CHECKER. Copying the self-test out instead meant it could no longer resolve the
# repository's own contract and catalogue: it aborted before any case ran, and
# all eighteen mutations below reported "caught" on the strength of that. The
# empty case name in the output was the only tell, which is why the name is
# printed at all.
target="$work/mutated.py"

survived=0
cases=0

# The unmutated baseline, asserted rather than assumed. Without it a self-test
# that had started failing for its own reasons would make every mutation below
# read as caught.
if ! PYTHON="$python_command" CHECKER="$work/pristine.py" bash "$selftest" >/dev/null 2>&1; then
  echo "BASELINE BROKEN: the self-test does not pass through CHECKER unmutated" >&2
  exit 1
fi
echo "baseline: the unmutated self-test passes through CHECKER"

# Each mutation names the case that must catch it. "The suite went red" is not
# evidence that the intended case went red, and the two sibling harnesses in this
# tree already take the expected case as a parameter for exactly that reason --
# a mutation caught by some unrelated case further down proves only that the
# suite is noisy.
mutate() {
  local name="$1" owner="$2" old="$3" new="$4" out status caught
  cases=$((cases + 1))
  cp "$work/pristine.py" "$target"
  if ! MUT_OLD="$old" MUT_NEW="$new" "$python_command" - "$target" <<'FIXTURE'
import os, pathlib, sys
p = pathlib.Path(sys.argv[1])
s = p.read_text(encoding="utf-8")
old, new = os.environ["MUT_OLD"], os.environ["MUT_NEW"]
if s.count(old) != 1:
    raise SystemExit(f"mutation target appears {s.count(old)} times, not once: {old!r}")
p.write_text(s.replace(old, new, 1), encoding="utf-8")
FIXTURE
  then
    printf 'BROKEN    %s (the mutation no longer applies uniquely)\n' "$name"
    survived=1
    return
  fi
  out="$(PYTHON="$python_command" CHECKER="$target" bash "$selftest" 2>&1)"
  status=$?
  if [ "$status" -eq 0 ]; then
    printf 'SURVIVED  %s\n' "$name"
    survived=1
    return
  fi
  caught="$(printf '%s\n' "$out" | grep -m1 '^self-test FAILED:' | sed 's/^self-test FAILED: //')"
  # A traceback is a symptom, not a verdict. Removing the guard on a short step
  # row makes the checker RAISE, which is exactly the defect that guard prevents,
  # so its owning case reports a traceback and that is a kill. A traceback with no
  # case named is a broken harness, and that distinction is the whole point.
  if [ -z "$caught" ]; then
    if printf '%s\n' "$out" | grep -q 'Traceback'; then
      printf 'BROKEN    %s (raised with no case named)\n' "$name"
    else
      printf 'BROKEN    %s (failed without naming a case)\n' "$name"
    fi
    survived=1
    return
  fi
  case "$caught" in
    *"$owner"*) printf 'caught by  %-50s <- %s\n' "${owner:0:50}" "$name" ;;
    *) printf 'WRONG CASE %s\n  expected: %s\n  caught by: %s\n' "$name" "$owner" "$caught"
       survived=1 ;;
  esac
}

echo "job-kind-catalogue mutations"
mutate 'a kind only the enum has goes unreported' \
  'a kind only the enum has is reported in that direction' \
  '        if kind not in kinds:' \
  '        if False:'

mutate 'a kind only the catalogue has goes unreported' \
  'a kind only the catalogue has is reported in the other direction' \
  '        if kind not in enum:' \
  '        if False:'

mutate 'the comparison is by set, so order stops mattering' \
  'the same kinds in a different order are caught' \
  '    if not errors and enum != kinds:' \
  '    if not errors and sorted(enum) != sorted(kinds):'

mutate 'an undocumented kind goes unreported' \
  'a kind no heading names is reported as undocumented' \
  '        if found == 1:' \
  '        if True:'

mutate 'a kind documented twice is accepted' \
  'a kind named by two headings is reported too' \
  '        if found == 1:' \
  '        if found >= 1:'

mutate 'an empty step cell is accepted' \
  'a step with no timeout is caught' \
  '            if not visible(value):' \
  '            if False:'

mutate 'a proof name is accepted without checking section 1 defines it' \
  'a proof name §1 does not define is caught' \
  '            if name not in proofs:' \
  '            if False:'

mutate 'only the first name of a proof cell is checked' \
  'a typo in the second name of a combined proof is caught' \
  '        claimed = CODE.findall(PARENTHETICAL.sub("", proof))' \
  '        claimed = CODE.findall(PARENTHETICAL.sub("", proof))[:1]'

mutate 'a parenthetical is read for names too, so an explanation becomes a proof' \
  'the committed contract and catalogue should agree' \
  '        claimed = CODE.findall(PARENTHETICAL.sub("", proof))' \
  '        claimed = CODE.findall(proof)'

mutate 'a cell that renders to nothing counts as filled in' \
  'a timeout that is only an HTML comment is no timeout' \
  '    return COMMENT.sub("", ENTITY.sub("", cell)).strip()' \
  '    return cell.strip()'

mutate 'a §1 row that names nothing is skipped instead of refused' \
  'a commented-out §1 row does not define anything' \
  '                    raise InputError(
                        f"{catalogue}: a row of the '"'"'{header}'"'"' table after {after!r} "
                        f"does not open with a back-ticked name: {row}"
                    )' \
  '                    continue'

mutate 'a cell naming no proof at all is accepted' \
  'a proof cell naming no proof at all is caught' \
  '        if proof and not claimed:' \
  '        if False:'

mutate 'a retry class is accepted without checking section 1 defines it' \
  'a retry class §1 does not define is caught' \
  '        if retry and retry not in retries:' \
  '        if False:'

mutate 'a short step row is unpacked anyway, raising instead of reporting' \
  'a step row with the wrong number of columns is reported' \
  '        if len(row) != STEP_COLUMNS:' \
  '        if False:'

mutate 'the permitted proofs are hard-coded instead of read from section 1' \
  'a §1 that no longer defines the proofs is an input refusal' \
  '        proofs = defined_names(catalogue, "A step'"'"'s idempotency proof is one of:", "Proof")' \
  '        proofs = {"declarative", "read-then-write", "natural-key", "guarded",
                  "read-only", "commit-marker", "command-id"}'

mutate 'the permitted retry classes are hard-coded instead of read from section 1' \
  'a commented-out §1 row does not define anything' \
  '        retries = defined_names(catalogue, "**Retry policy classes.**", "Class")' \
  '        retries = {"A", "B", "C", "D"}'

mutate 'an unreadable input is reported as a finding, at status 1' \
  'a delimiter row on the first line is refused' \
  '        print(f"JOB-INPUT: {exc}", file=sys.stderr)
        return 2' \
  '        print(f"JOB-INPUT: {exc}", file=sys.stderr)
        return 1'

mutate 'a missing file is treated as empty rather than refused' \
  'a missing catalogue is an input refusal' \
  '    if not path.is_file():
        raise InputError(f"{path} is not a file")' \
  '    if not path.is_file():
        return ""'

mutate 'findings are printed but the check exits 0' \
  'a kind only the enum has is reported in that direction' \
  '        print("\n".join(errors), file=sys.stderr)
        return 1' \
  '        print("\n".join(errors), file=sys.stderr)
        return 0'

mutate 'the summary says it checked the steps when it counted none' \
  'the step count should follow the document, not be a constant' \
  '        f"{len(documented)} documented, {len(steps)} steps name a proof §1 defines "' \
  '        f"{len(documented)} documented, 96 steps name a proof §1 defines "'

mutate 'the summary stops naming what it did NOT check' \
  'the summary should say what it did NOT check' \
  '        f"and a retry class §1 defines; step semantics and runtime behaviour unchecked"' \
  '        f"and a retry class §1 defines"'

mutate 'a pipe escaped as backslash-pipe is split on anyway' \
  'an escaped pipe inside a cell is one cell, not two' \
  '    return [cell.replace("\\|", "|").strip() for cell in CELL.split(body)]' \
  '    return [cell.strip() for cell in body.split("|")]'

mutate 'every table under section 2 is read as steps, whatever its header says' \
  'a non-step table under a kind is passed over' \
  '        elif is_step_table(header):' \
  '        elif True:'

mutate 'a steps table is recognised by its whole header, so renaming a column skips it' \
  'a renamed steps-table header is refused' \
  '    return bool(header) and header[0] == STEP_MARKER' \
  '    return len(header) == STEP_COLUMNS and header[-1] == STEP_TAIL'

mutate 'a malformed steps header is accepted and its rows silently dropped' \
  'a renamed steps-table header is refused' \
  '            if header[-1] != STEP_TAIL:' \
  '            if False:'

mutate 'any table that is not steps is read as the kind table' \
  'a non-step table under a kind is passed over' \
  '        if header and header[0] == KIND_HEADER:' \
  '        if header and header[0] != STEP_MARKER:'

mutate 'a delimiter row whose header disagrees is read as a table anyway' \
  'a delimiter row that anchors no table is refused' \
  '        if len(header) != len(split_row(line)):' \
  '        if False:'

mutate 'the declared size bound is not enforced' \
  'a contract over the declared size bound is refused' \
  '    if len(raw) > MAX_BYTES:' \
  '    if False:'

mutate 'a non-UTF-8 input is decoded lossily instead of refused' \
  'a catalogue that is not UTF-8 is refused, not decoded lossily' \
  '        return raw.decode("utf-8")' \
  '        return raw.decode("utf-8", "replace")'

mutate 'an empty enum agrees with an empty catalogue' \
  'an empty enum is refused rather than agreeing with nothing' \
  '    if not enum:' \
  '    if False:'

mutate 'an enum that is not a list of strings is accepted' \
  'an enum entry that is not a string is refused' \
  '    if not isinstance(enum, list) or not all(isinstance(k, str) for k in enum):' \
  '    if False:'

mutate 'a third argument is ignored rather than refused' \
  'a third argument should print usage' \
  '    if len(args) > 2:' \
  '    if False:'

mutate 'a section 1 table that names nothing is read as an empty permitted set' \
  'a §1 table with no rows at all names nothing' \
  '                raise InputError(f"{catalogue}: the '"'"'{header}'"'"' table after {after!r} names nothing")' \
  '                pass'

mutate 'a section 1 name must be the whole cell, so an annotated one stops defining it' \
  'an annotated name in §1 still defines that proof' \
  '            names = set()
            for row in rows:
                named = LEADING_CODE.match(row[0]) if row else None' \
  '            names = set()
            for row in rows:
                named = CODE.fullmatch(row[0]) if row else None'

mutate 'JOB-DOC reads its headings from the raw text, so a fenced one counts' \
  'a heading inside a fence does not document a kind' \
  '    headings = [m.group(1) for m in (SUBSECTION.match(line) for line in lines[start:end]) if m]' \
  '    raw = read(catalogue).splitlines()
    headings = [m.group(1) for m in (SUBSECTION.match(line) for line in raw[start:end]) if m]'

mutate 'a fence closes on either marker, so a nested one closes the outer block' \
  'a backtick line inside a tilde block does not close it' \
  '        if fence and opener is not None and fence.group(1)[0] == opener:' \
  '        if fence and opener is not None:'

mutate 'an unclosed fence is tolerated and blanks the rest of the document' \
  'an unclosed code fence is refused, not left to blank the rest' \
  '    if opener is not None:
        raise InputError("a code fence is opened and never closed")' \
  '    if False:
        raise InputError("a code fence is opened and never closed")'

mutate 'an indented code block is read as data' \
  'a table in a four-space indented block is an example too' \
  '            indented = True' \
  '            pass'

mutate 'the outer pipes are required, so a pipe-less row is invisible' \
  'a step table with no outer pipes is read, not skipped' \
  '    if body.startswith("|"):
        body = body[1:]' \
  '    if not body.startswith("|"):
        return [body]
    body = body[1:]'

mutate 'a delimiter row with no header above it is read anyway' \
  'a delimiter row on the first line is refused' \
  '        if index == 0:
            raise InputError("line 1 is a table delimiter row with no header above it")' \
  '        if False:
            pass'

mutate 'a steps table outside section 2 is tolerated' \
  'a steps table outside §2 is refused, not quietly unread' \
  '        if is_step_table(header) and not (start <= index < end):' \
  '        if False:'

mutate 'the order report fires even while the lists differ in membership' \
  'the order report is silent while the lists differ in membership' \
  '    if not errors and enum != kinds:' \
  '    if enum != kinds:'

mutate 'an empty retry cell is also reported as an undefined class' \
  'an empty retry cell is reported once, not also as an undefined class' \
  '        if retry and retry not in retries:' \
  '        if retry not in retries:'

mutate 'an empty proof cell is also reported as naming no proof' \
  'an empty proof cell is reported once, not also as naming no proof' \
  '        if proof and not claimed:' \
  '        if not claimed:'

mutate 'a renamed kind-table header becomes sixteen findings, not a refusal' \
  'a renamed kind-table header is an input refusal, not sixteen findings' \
  '    if not kinds:' \
  '    if False:'

mutate 'a heading does not end a table, so it is absorbed as a row' \
  'a heading ends a table even with no blank line before it' \
  '            if not nxt.strip() or HEADING.match(nxt) or is_delimiter(nxt):' \
  '            if not nxt.strip() or is_delimiter(nxt):'

mutate 'an indented block after a sentence is read as an example' \
  'four-space indentation after a sentence is data, not an example' \
  '        if not indented and previous_blank and line.startswith("    ") and line.strip():' \
  '        if not indented and line.startswith("    ") and line.strip():'

mutate 'a delimiter row need not contain a dash' \
  'a row of empty cells is not a delimiter row' \
  '    return bool(body) and "|" in body and "-" in body and set(body) <= set("-:| \t")' \
  '    return bool(body) and "|" in body and set(body) <= set("-:| \t")'

mutate 'a tab is not permitted in a delimiter row, so one tab hides the table' \
  'a tab in a delimiter row still leaves the table read' \
  '    return bool(body) and "|" in body and "-" in body and set(body) <= set("-:| \t")' \
  '    return bool(body) and "|" in body and "-" in body and set(body) <= set("-:| ")'

mutate 'an HTML block is read as Markdown, so a heading inside one counts' \
  'a heading inside an HTML block does not document a kind' \
  '        if html_tag is None and opener is None:' \
  '        if False:'

mutate 'an unclosed HTML block is tolerated and blanks the rest' \
  'an unclosed HTML block is refused, not left to blank the rest' \
  '    if html_tag is not None:
        raise InputError(f"an HTML <{html_tag}> block is opened and never closed")' \
  '    if False:
        raise InputError(f"an HTML <{html_tag}> block is opened and never closed")'

echo
if [ "$survived" -ne 0 ]; then
  echo "AT LEAST ONE MUTATION SURVIVED: a rule no case owns is a rule nobody proved"
  exit 1
fi
echo "every mutation was caught by a named case ($cases mutations)"
