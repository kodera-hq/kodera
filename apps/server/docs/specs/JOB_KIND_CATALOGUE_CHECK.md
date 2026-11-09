# Offline job-kind catalogue check

**Status:** Proposed · **Owner:** API seat

`JobKind`'s own description in `contracts/core-api.openapi.yaml` has said that
"a contract test compares the two in both directions". No test file referenced
`JobKind`. This is that test.

A sentence asserting a test nobody wrote is worse than a missing test, because it
tells a reader nobody has to check. The repair was to write the test rather than
delete the sentence: the invariant it claims is real, cheap to check, and the two
documents it relates are edited by different people for different reasons.

Interface: `bash contracts/check-job-kind-catalogue.sh [contract] [catalogue]`.
Success exits 0, a disagreement between the documents exits 1, and an input that
cannot be read or parsed exits **2** — "the documents disagree" and "I could not
read one of them" call for different repairs, and a gate that conflates them
cannot be trusted in either direction. Input is bounded to 2 MiB before parsing,
and nothing is fetched or resolved outside the two files named.

## What it asserts

| Rule | Claim in the contract it makes true |
|---|---|
| `JOB-LIST` | "this enum and §2 of `docs/domain/JOB_CATALOGUE.md` are one list" — and "in order", per `contracts/CONSOLE_RECONCILIATION.md`. The three ways the two can disagree are reported apart: a kind only the enum has, a kind only the catalogue has, and the same kinds in a different order each call for a different repair |
| `JOB-DOC` | "the catalogue is the closed set" — every kind in §2's table is named by exactly one `###` heading **under §2**. Some headings name two kinds, which is how the catalogue is written; what is refused is a kind named by none, or by two |
| `JOB-STEP` | "each kind … carrying its ordered steps, a named idempotency proof per step, a timeout, a retry class and a compensation" — every step row fills all four cells, and every proof name and retry class it claims is one §1 actually defines |

Before any of those, the **parser is the first thing that has to be right**, and
twice it was not. A table it failed to recognise simply disappeared from the scan:
an undefined proof among its rows went unreported and the only trace was a smaller
number in the summary, which nothing asserts. Two reviews found five shapes that
did it — indenting a table two spaces (which one of this repository's own documents
already does), quoting it, appending an HTML comment to a row, moving it under a
sibling `## 2.1` heading, and **omitting the outer pipes, which GFM allows on every
row**. The last of those read fifteen kinds out of sixteen and reported them as
agreeing in both directions.

So a table is anchored by its **delimiter row**, the one line whose shape cannot be
anything else, and every delimiter row in the document either anchors a table or is
refused. Indented, quoted and pipe-less tables are therefore *read* rather than
refused — being read is what makes them checked. A steps table outside §2 is
refused, because nothing there would read it.

Code blocks are blanked first, line numbers preserved, so an example is not data: a
fence, or a four-space indented block, which cannot interrupt a paragraph — and that
last rule is also what keeps a table indented inside a **list** readable as a table.
A fence closes only on its own marker and an unclosed one is refused: left alone, a
single stray ``` under §2 blanked the rest and took the scan from 96 steps to 0.

The permitted proof names and retry classes are **read from §1's own tables**, found
by their own headers. A list copied into a checker stops agreeing with the document
it checks; and finding the table by position instead meant one clarifying table
inserted above it made every real proof undefined.

## What it deliberately leaves unchecked

- **Step semantics.** That `verify_boundary` really verifies a boundary is not a
  property of the table.
- **Runtime behaviour.** Nothing here runs a job, takes a lock, or observes a
  retry. The catalogue's lock and status columns are read as text.
- **The timeout's shape.** Presence only. One real row reads
  `remainder of the TTL`, so a duration-shaped rule would refuse a document that
  is correct — over-strict is a defect too.
- **Step order.** The ordinal column marks a steps table and is then not validated,
  so `1, 2, 2, 5` passes while the quoted clause says "its *ordered* steps".
- **A second proof name joined by anything but `+` or `and`.** `or`, `/`, `then` and
  bare juxtaposition stop the read at the first name. Measured in the live document:
  `and` once, `+` once, none of the others. A comma-clause is deliberately *not* a
  joiner — three real rows read `` `natural-key` (`tenant`, `name`, `version`) ``.
- **Prose counts elsewhere.** `CONSOLE_RECONCILIATION.md` spelled the number of
  kinds as a word and was wrong by one; nothing compares a spelled-out number in
  prose to a measured one.
- **A duplicated `JobKind:` key** in the contract. `yaml` keeps the last mapping
  and discards the first silently, so "JobKind's enum" is ambiguous in a file with
  two and this cannot say so.
- **`MODEL.md` against the schema.** A separate, still-open gap.

### One shape it cannot see, and the reason it is the last one

A table inside a list item whose content indent is **four columns** — `10. `, `1.  `,
`-   ` — is read by GFM as a table and by this check as an indented code example.
Measured: a steps table placed there, carrying an undefined proof and an undefined
retry class, exits 0 and leaves the step count unchanged, so the summary's count does
not catch it either. The catalogue has seven ordered-list items today and no table
inside one.

Four spaces after a blank line is an indented code block in CommonMark *and* the
content indent of a two-digit list item. Telling them apart needs a list-aware
parser, and this check is not one.

**That is the honest limit of the approach**, and it is worth stating as a
recommendation rather than a footnote: three independent reviews each found more
shapes a line-based reader mis-sees — five in the first two rounds, nine in the third,
and every one of them was a real defect. The durable fix is one of two things, and
both are the owner's call:

1. **Read the catalogue with a real GFM parser.** `cmark-gfm` is what GitHub renders
   with, and it is what the third review used to prove these shapes render as tables.
   That means a new pinned dependency in a repository whose supply-chain policy makes
   that a decision, not a detail.
2. **Stop parsing the data out of prose.** If §2's kinds and steps had a
   machine-readable source — a YAML block, or a file the prose table is generated
   from — there would be no parser to fool, and the check would become a comparison
   of three artefacts rather than two.

Until one of those happens, this check is worth having and is not airtight: it
enforces the list comparison and the per-step rules for every ordinary edit, and the
shape above is the one way a correct-looking document can still slip past it.

## Proofs

`bash contracts/check-job-kind-catalogue.selftest.sh` — **72 cases**, 9 s. Each
asserts the refusal **message** and the exact exit status, because the check refuses
in nine distinct ways at status 1 and more than twenty at status 2. 23 cases
assert status 2.

**15 assert the opposite — that a correct document is accepted** — and every
one of those was a real refusal of a legitimate edit first: an escaped pipe
in a cell, a non-step table under a kind, alignment colons, a footnote on a kind, an
annotated name in §1, emphasis round a proof, `and` between two defined proofs, a
fenced example, a four-space indented example, a table nested in a list, a backtick
line inside a tilde block, a heading abutting a table, a `###` above the kind table,
a row-shaped line that is prose. Over-strict is a defect too, and it is the half that
gets skipped.

**3 assert a message is ABSENT.** A guard that suppresses a duplicate or
contradictory message cannot be proven any other way: every such guard survived
mutation until these existed, because a case that greps for a wanted line does not
notice a second unwanted one beside it.

`bash contracts/check-job-kind-catalogue.mutations.sh` — **51 mutations, 0
survivors**, ~3 min. Each removes one rule and **names the case that must catch it**.
The harness refuses a run where some other case caught it instead, asserts an
unmutated baseline first, requires each target to appear exactly once, and tells a
traceback *with* a case named (a kill — removing the guard on a short row makes the
checker raise, which is the defect) from one *without* (a broken harness). All four
ways of fooling it were tried and reported correctly.

Five results from building it are worth keeping:

- The first harness copied the self-test to a temporary directory, where it could
  no longer resolve the repository's own documents. It aborted before a single case
  ran, and all eighteen mutations reported "caught" on the strength of that. The
  empty case-name column was the only tell.
- The summary's step count was asserted once, against one document, so a mutation
  replacing the computed count with the literal `96` passed.
- Accepting "some case went red" hid **eleven rules no case owned**, including the
  2 MiB bound this document advertises by name.
- A block rewrite silently **deleted a case**, and two mutations survived until the
  deletion was found. The harness's own output is what found it.
- Two clauses were removed rather than pinned, because no mutation could kill them:
  a `^` in a pattern applied with `.match`, which anchors anyway, and the
  column-count half of the steps-header test, which every row's width check already
  covers. A clause no case can own is not a clause.

`yaml`'s C loader is used when the runner has it and the pure-Python parser
otherwise: identical results, and ten times the runtime of every proof above.

## Changelog

- Added with the check. The claim in `JobKind`'s description became true rather
  than being deleted, and `CONSOLE_RECONCILIATION.md`'s count of the kinds was
  corrected from fifteen to sixteen in the same change.
- Rewritten twice after review, before merge. The first round read tables by their
  header rather than guessing from a row's first column. The second anchored them on
  the delimiter row, after a reviewer showed the check could still report "fifteen
  job kinds agree in both directions" while §2 listed sixteen.
