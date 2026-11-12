# Workspace templates and the theme vocabulary

**Status:** Proposed · **Owner:** API seat

The official workspace templates a claim names (`instantClaimWorkspace`), and the two vocabularies of
contract 0.42.0 it names them with: `WorkspaceTemplateId`, with the `proximity` template and its
permanent alias, and `ThemeId` with `ThemeIdAlias`. The code is `apps/workspaces/templates.py`,
`apps/workspaces/warm_pool.py` and `apps/workspaces/instant_claim.py`; the acceptance is
`tests/test_workspace_templates_warm_pool.py` and `tests/test_instant_claim_http.py`.

## 1. Identifiers and labels

An identifier is ASCII, is what a client sends and what Core stores, and is never shown to a person.
A label is what a person reads; it comes from a message catalogue, and is never sent or stored as an
identifier. Core owns a label only where it says so below.

## 2. The proximity template

| | |
|---|---|
| Canonical identifier | `proximity` |
| Deprecated alias | `crisis-cell`, permanent |
| Display label | `#proximity` (English), `#proximité` (French) |
| Category | one, template key `proximity` |
| Default channel | exactly one: slug `proximity`, template key `proximity`, text |
| Default theme | `black` |

- **One template, two names.** `crisis-cell` is the identifier this template took before 0.42.0. Core
  accepts it for as long as the contract exists, resolves it to the same template as `proximity`
  (`canonical_template_id`), and never answers it differently: the same plan, the same channels, the
  same refusals. The catalogue lists the template once, as `proximity`.
- **Exactly one default channel.** The template creates the `proximity` room and nothing else.
- **More proximity channels, and their members.** Nothing new exists for them and nothing blocks
  them. An owner or admin adds a channel with `createChannel`, in the proximity category or
  elsewhere, under any name, the slug `proximity` again included: a slug is not a key, and only the
  template's own channel carries the template key. Members are brought into a channel with its
  access document (`patchChannelAccess`: `visibility: restricted` and `allow_members`), the mechanism
  every other channel uses ([`ESPACE_STRUCTURE.md`](ESPACE_STRUCTURE.md) §§3, 6).
- **Not an emergency service.** The default channel's topic, which Core owns, says in English and in
  French that proximity is not an emergency service and that in an emergency one calls the local
  emergency number. A client that shows its own notice keeps doing so; this is the copy Core carries.
- **The labels** are the template's `label_en` and `label_fr`. The plan's `template_label_fr` is
  `#proximité`. Neither is the channel's slug.

A workspace prepared from the template's earlier layout (five channels in three categories) no
longer matches the template: its allocation is not claimable and the claim answers
`warm_pool_unavailable`, as for any plan that does not match. Nothing rewrites a stored workspace.

## 3. The theme vocabulary

| `ThemeId` | Alias before 0.42.0 |
|---|---|
| `light` | `givre` |
| `dark` | `ardoise` |
| `black` | `real-black` |
| `ciel` | none |
| `ciel-nuit` | none |

- **A claim accepts all eight** as `themeId`, and anything else is `400`. Omitted, the template's
  default applies; every default is a `ThemeId`, never an alias.
- **One canonicalisation, used by both sides.** `canonical_theme_id` reads an identifier as the
  `ThemeId` it names. The claim path applies it to what the request sends, and `canonical_plan`
  applies it to the plan a prepared allocation holds, before the two are compared. A claim sending
  `light` therefore matches a plan prepared as `givre`, and a claim sending `givre` a plan prepared
  as `light`. A plan Core builds never holds an alias.
- **A stored plan is read, never rewritten.** `canonical_plan` returns a copy with `theme_id` and
  `template_id` replaced by the identifiers they name. Every other member is compared as it is, and
  a value that names nothing is left alone and matches no claim.
- **A different theme is a different plan.** Canonicalisation folds an alias into its `ThemeId` and
  nothing else: `givre` and `dark` do not match.

The two reserved schemas of 0.42.0, `ProximityCheckInHandle` and `ProximityCheckInPseudonym`, are
carried by no operation, and Core serves nothing for them.

## 4. Acceptance

- `tests/test_workspace_templates_warm_pool.py`, in memory: one case per rule above, each run
  against `apps/workspaces/templates.py` and against a mutant with one anchor replaced: the alias
  removed, the alias naming another template, `crisis-cell` a template of its own again, a second
  default channel, the label used as the slug, the non-emergency notice dropped, a theme alias
  removed or naming another theme, a `ThemeId` refused, any string a theme, a stored plan that keeps
  its alias, a read that rewrites the stored plan. The server's vocabularies equal the contract's
  enums.
- `tests/test_instant_claim_http.py`, with real signed tokens: `proximity` and `crisis-cell` claim
  the same prepared workspace, whichever of the two prepared it, and are refused alike without one;
  each `ThemeId` claims the plan prepared for it; a claim and a stored plan meet whichever of a
  theme's identifiers each holds, and with the stored plan read raw that check fails by name; a
  proximity workspace takes further proximity channels, by an owner and by an admin, and a member is
  brought into a restricted one through its access document.

## Changelog

- Specifies the `proximity` template with its permanent alias `crisis-cell`, and the theme
  vocabulary with the one canonicalisation a claim and a stored plan share.
