# Application cards

Status: Implementation and the reviewed preview adaptations approved by the owner; protected CI and merge acceptance remain required.

## Scope

Follow the complete product mock's Applications block: one card per Core-returned application, with an identifying glyph, name, optional served version, textual health status and working open action. Place primary and fallback addresses beside each other on wide screens and stack them at narrow widths. Preserve the existing status page, capacity and incident behavior.

The pinned TenantApp contract supplies code, name, url, optional default_url, optional version and state. Existing mocked responses supply acceptance fixtures. Do not invent the reference's activity metrics, future applications, event history or customisation/export actions; they require separate contract and feature work. No endpoint or permission change is part of this task.

## Behaviour

- Each application is a named region, with its name as a heading under the existing applications section heading.
- A served version is visible; an absent/null version leaves no fabricated version or empty label.
- Every contract state (pending, live, degraded, unavailable, maintenance) has a truthful text label and corresponding existing status primitive. Unrecognized or missing runtime states show a neutral unknown label while addresses and opening remain usable. Never infer health from an address or invent a healthy default.
- Primary and fallback addresses remain visible/selectable and independently copyable. Fallback is rendered whenever Core supplies it. Preserve the clipboard generation guard: a late result for an old address cannot confirm a new address.
- Opening retains the application URL, new-tab announcement, safe relationship and existing analytics. Names and labels remain in both catalogues.
- Any shared copy-field layout extension defaults to its existing inline layout so other screens keep their behavior.

## Acceptance before publication

First demonstrate failing tests for named per-application regions, served version and all state labels on the old grouped card. Then pass those tests along with existing copy, stale-promise and opening regressions. Verify optional fields, a long address, multiple applications and no applications without fabricated data. Browser acceptance checks keyboard copy/open and responsive address layout. Full static, unit and relevant journey checks pass; pinned light/dark/black/narrow baselines are inspected without tolerance changes. Independent adversarial, separate CTO, lead verification, owner preview decision and protected current-base CI precede merge.

Approved preview adaptations: retain shared component/token typography rather than raw mock values; omit unsupported metrics and inert actions. Core remains the only data source.
