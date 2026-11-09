# Architecture decision records

One file per decision, numbered, never edited after acceptance except to change **Status** (Proposed → Accepted → Superseded by ADR-nnnn, or Amended by ADR-nnnn when a later record replaces part of it rather than all of it). Template: [`0000-template.md`](0000-template.md).

| # | Title | Status |
|---|---|---|
| [0001](0001-tokens-package-is-the-single-source.md) | This package is the single source of design values, and its build output is committed | Proposed |
| [0002](0002-decided-values-move-and-spec-constants-are-measured.md) | A decided value moves in `tokens.json`, and the constants the build adds are measured | Proposed |

Upstream: `kodera-console/docs/adr/0004-shared-design-tokens.md`, which established that the tokens are a shared package and named this repository as it.
