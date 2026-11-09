# The dark workspace reference: colour roles on today's surfaces

Status: Implemented, including the structural workspace slice.

zôÖma approved the dark workspace reference screens. The approval came with two changes, both made earlier: icons only (`icon-only-controls.md`), and presence as a small dot (a later slice).

The colour-role slice and the structural workspace slice share the approved reference.

- Every value is a token role of kodera-design-tokens v0.6.0. Nothing is inlined, and there are no gradients.
- The roles resolve in each theme. Light, dark and black all follow the same map; the member's choice in « Apparence » is unchanged.

## Role map (what this slice changes)

| Surface | Before | Now |
|---|---|---|
| Call dock (sidebar foot, phone banner) | `c-action` ground, controls on `c-action-hover` | `c-inverse` ground with `inverse-edge`; controls on `c-inverse-2`; a pressed toggle is the `c-on-inverse` plate; « Quitter » `c-bad`, the only red fill |
| Call dock text | all `c-on-inverse` | room `c-on-inverse`; category `c-on-inverse-dim`; the state in `text-sm` bold, `c-ok-on-dark` with its dot and the mic meter when connected, `c-on-inverse-dim` while waiting |
| Call dock's « Réglages audio » and « Revenir à l'appel » | bare glyph on the ground | `c-inverse-2` square, `c-on-inverse-dim` glyph (8.23 / 7.58 / 7.91 : 1), its ring offset like the controls' |
| Sidebar search | a bordered `c-surface` field, 40 px | a muted well, `c-muted`, no border, deepening to `c-muted-2` on hover, 32 px, with the 44 px floor on a narrow screen; its shortcut chip keeps its edge and loses its fill |
| Current channel, before the live workspace opens (`ChannelSidebar`) | `c-accent-soft`, 1 px `c-accent-ink` edge, `c-action` bar, `c-ink-3` glyph | `c-accent-soft`, no edge, 3 px `c-accent-ink` bar inset 4 px and fully round, `c-accent-ink` glyph |
| Current channel in the live workspace (`ChannelRow`) | already `c-accent-soft` with a `c-accent-ink` bar, inset 8 px, `c-ink-3` glyph | the same bar as above, and the `c-accent-ink` glyph |
| Composer | `c-surface` box, `rounded-md` | `c-muted` well, `rounded-lg`; its tools hover to `c-surface` |

Already on the reference's roles, and unchanged:
- the rail (`c-inverse`);
- the sidebar (`c-sunken`);
- the channel column (`c-surface`);
- the header rule (`c-border-soft`);
- a message's hover (`c-muted`).

## Accessibility

Contrast in light / dark / black, measured from the tokens file:

| Pair | Contrast |
|---|---|
| Dock text: `c-on-inverse` on `c-inverse` | 17.74 / 18.51 / 20.03 |
| Dock text: `c-on-inverse-dim` | 9.52 / 8.76 / 9.42 |
| Dock text: `c-ok-on-dark` | 12.39 / 10.96 / 11.55 |
| Control glyphs on `c-inverse-2` | 15.35 / 16.01 / 16.82 |
| « Quitter » against the dock | 3.27 / 3.68 / 3.88 |
| « Quitter »'s glyph | 5.42 / 5.03 / 5.17 |

- **Controls.** A control's fill is close to the dock (1.16 : 1). The glyph is what identifies the control, well above 3 : 1 (WCAG 1.4.11). This is also how the reference draws it.
- **Composer.** The composer keeps its input edge: a text field needs a boundary. `c-border-input` measures 3.21 / 3.71 / 3.26 on `c-muted`. This is one deliberate departure from the reference, which draws the composer with no edge.
- **Search.** The search trigger is a button named by its word and glyph: « Rechercher » in `c-placeholder` measures 5.06 / 5.52 / 4.92 on `c-muted`.
- **Search hover.** On hover the well deepens to `c-muted-2`: « Rechercher » stays 4.51 / 4.84 / 4.58 : 1 on it, and the shortcut chip's `c-ink-3` 4.51 / 5.33 / 6.84; the light figures are just above the 4.5 floor.
- **Current channel.** The current channel is told apart by its bar and its weight, not by colour alone.
- **Unchanged.** Focus rings are unchanged. Inside the dock, they are the on-inverse ring offset onto `c-inverse` (`focus-ground-inverse`).

## Structural workspace slice

- A one-row composer with its existing input boundary.
- A welcome block at the head of a channel.
- 40 px faces, one tone per member.
- The members panel, grouped by room role, including the signed-in member and excluding service accounts.
- The sidebar header without the slug.
- Nothing after an empty audio room's name.
- The voice panel's member row.
- The presence dot.
- The thread composer uses a `c-muted` field and an icon-only reply button.
- Non-current channel rows use `c-ink-3` and `rounded-sm`.

## Acceptance

`npx vitest run src/ui/AudioDock src/features/espace/AudioSettings.test.tsx src/ui/ChannelRow src/features/workspace/WorkspaceScreen.test.tsx src/features/espace/EspaceLiveView.test.tsx` checks:
- the dock's ground, controls, state and meter roles;
- that « Quitter » is the dock's only red fill, in any state variant;
- the search trigger's well;
- the current channel's row and bar;
- the composer's well with its edge kept.

The visual baselines move on purpose wherever a dock or the sidebar is drawn.
