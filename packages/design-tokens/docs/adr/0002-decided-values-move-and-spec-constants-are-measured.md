# ADR-0002: A decided value moves in `tokens.json`, and the constants the build adds are measured

**Status:** Proposed
**Amends:** [ADR-0001](0001-tokens-package-is-the-single-source.md), points 1 and 2
**Deciders:** the crew

## Context

ADR-0001 wrote two rules tighter than the system turned out to need, and this repository has now run into both of them at once.

**Point 1 — "`tokens.json` is carried verbatim… It never edits a value."** That rule was written while every failing contrast pair was an open design question, and it is the right rule for that state: a build repository is not where an unanswered design question gets answered. It is the wrong rule once the question is answered. Four tertiary-text rows, the input border and the focus ring were carried in `contrast-known-failures.json` as debt awaiting a decision. The decision was taken and signed by the owner. Under the letter of point 1, the only place the ruling could land was the allowlist — an entry saying "decided, and still failing", which is precisely the rot the allowlist is written to prevent. `AGENTS.md` already states the workable rule: a value change is a design decision that arrives as a PR here **with the contrast gate green** or with an allowlist entry naming who decided what. ADR-0001 is the document that disagrees.

**Point 2 — "the build is a pure function of `tokens.json`."** It is not, and has not been since the first commit. `scripts/build.mjs` also emits the page gradient and the focus ring, neither of which `tokens.json` v0.1 carries: the gradient's angle and stops, and the ring's geometry. The two-tone ring makes that visible rather than new — the ring is now an opaque core inside the delivered 35 % halo, and both the widths and the alpha live in the build.

That second gap is not a documentation problem. A geometry only the build knows is a geometry no check can measure. With the ring's alpha living in `build.mjs` and the contrast rows naming a token instead, the rows reported 6.70:1 for **any** ring the build emitted — including the single 35 % halo that measures 1.78:1 and satisfies nothing. The gate went green on the sentence in the row's label rather than on the ring in `dist/tokens.css`.

## Decision

**A decided value moves in `tokens.json`; a constant the build adds to it lives where the gates can read it, and every colour it composes is measured.**

1. **A token value may change here when the change is a design decision that has been taken**, recorded in the token's `$description` with the ratio it now measures, and shipped with the contrast gate green. It is still never a way to make a check pass, and an undecided question still goes to `contrast-known-failures.json` with the decision it waits on. This replaces ADR-0001 point 1's "never edits a value".
2. **The build is a pure function of `tokens.json` and `scripts/lib/spec.mjs`** — same inputs, byte-identical output, no clock, no environment, no network. `spec.mjs` holds the values the design system fixes that `tokens.json` v0.1 does not carry as tokens: today the page gradient and the focus ring. Every colour in it is a token path, never a hex, so a palette change flows through and a token rename fails the build. This replaces ADR-0001 point 2's single input.
3. **Every colour the build composes from a spec constant is measured by a row in `contrast-pairs.json`, and the row addresses it by role rather than by naming a token that resembles it.** The focus ring is read through a `spec:` role per tone — the tone painted against the control, and the tone painted onto the background — at the alpha the build gives each, and a role names every dimension the ring varies over, so that a row cannot measure one ring while a control paints another. That second half is enforced, not asserted: `test/color-math.selftest.mjs` reads the variants out of `SPEC.focusRing.variants` and the grounds out of the theme roles themselves, so a variant added to the spec composes tones that carry no row and fails the suite, and a ground added to the themes has to be measured before it ships. A geometry change therefore moves what the gate measures. A constant that composes a colour no row measures is the gap this ADR exists to close.

ADR-0001's points 3, 4 and 5 stand unchanged: `dist/` stays committed and drift-gated, the generated names stay frozen by the parity test, and every gate still fails loudly or not at all.

## Options considered

| Option | Why not |
|---|---|
| **Chosen: amend points 1 and 2, and require a measured row per composed colour** | Keeps both defences that matter — a value moves only by a decision, and nothing the build composes escapes the gate — while letting a signed decision land in the value where the consumers read it. |
| Leave point 1 as written; record the signed decision in `contrast-known-failures.json` | The allowlist would carry entries that say "decided, and still failing". An allowlist whose entries are not waiting on anything cannot be read as debt, and nothing would ever delete them. |
| Leave the constants private to `scripts/build.mjs` | What the branch under review did. The ring's alpha and the row's assumption then live in two files with nothing holding them equal, and the gate keeps printing a ratio for a ring that is no longer there. |
| Repeat the alpha as a literal in the contrast row | The same two-places-one-number failure, one file further along: the row measures the ring it was written against, not the ring that ships. |
| Carry the ring in `tokens.json` as a DTCG shadow token, and delete the constant | The end state, and this ADR does not block it. `tokens.json` is the design workstream's delivery; a multi-layer ring invented here is a value nobody in that workstream chose. It lands when the drop carries it, or when a component tier exists to hold it. |

## Consequences

- A PR that moves a value carries three things or it is not reviewable: the decision, the `$description` with the new measured ratio, and a green contrast gate. `dist/` moves with it, which is the point — a reviewer sees the CSS the decision produces.
- `scripts/lib/spec.mjs` is a build input. A change there shows up in `dist/` and in the contrast report exactly as a token change does, and the drift gate still proves `dist/` is generated rather than written.
- Adding a spec constant now has a cost: if it composes a colour, it needs a role and a row. That cost is the whole decision.
- `contrast-known-failures.json` shrinks to rulings rather than pending questions. An entry there still means a decision is owed, and an entry whose pair starts passing still fails the gate.
- `AGENTS.md` repeats ADR-0001's single-input sentence and needs the same amendment. It is untouched here on purpose: a PR that edits `AGENTS.md` needs a second human reviewer under that file's own rule, and this one is an accessibility fix. The rule that binds is this ADR; the working-rules file follows in a PR of its own.
- Revisit when the design drop carries the ring and the gradient as tokens, or when the component tier lands. `spec.mjs` should end up empty; while it is not, points 2 and 3 are what keep it honest.
