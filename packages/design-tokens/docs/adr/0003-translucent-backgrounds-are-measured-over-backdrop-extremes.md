# ADR-0003: A translucent background is measured over declared backdrop extremes, and held to the worst case

**Status:** Proposed
**Deciders:** the crew

## Context

The contrast gate measures a foreground against what is painted behind it. Until now it refused every background that was not opaque, because a translucent surface has no colour of its own: what a user sees is the surface laid over whatever lies underneath. A row that named only the tint would be measured against a ground that never exists, and nothing would say so.

The "Ethereal Sky Glass" family (`docs/specs/ethereal-sky-glass.md`) is built on translucent materials with `backdrop-filter: blur() saturate()`. Refusing them outright would leave every glass surface unmeasured; measuring the tint would be the lie the gate exists to stop. The family becomes a default only after a worst-case contrast gate passes, so the gate has to be able to state a worst case.

## Decision

**A translucent background stays a hard failure unless the row says what can lie behind it. With that said, the row is measured over every declared extreme and over the bounds of every blend of them, and it must clear its minimum on the worst one.**

1. A row whose `bg` is not opaque fails, as before, unless it binds a `backdropSet`: the **name** of a set declared under `backdropSets` in `contrast-pairs.json`. A set has a `purpose`, the one registered `theme` whose extremes it holds, and a non-empty list of **opaque** `members`, each a token path or a literal. A missing binding, an undeclared name, a set with no theme or with a theme the registry does not hold, an empty set, a member that is not opaque, a member that does not resolve: each is a hard failure with its own sentence.
   - **The ground decides whose extremes apply, not the row.** A translucent ground that belongs to a theme — a material, a theme role such as the scrim, a theme primitive — is read for its theme from where the token lives, and is measured only over a set declared for that theme. Another theme's set is refused.
   - **There is no inline form.** A list of colours written into the row is refused on every ground: it is how a row would choose the extremes it passes on, and no shipped row needs it.
2. A row may also declare `layers`: translucent colours stacked between the backdrop and the background, bottom first (a dialog over the scrim). An opaque layer is refused; it hides the backdrop and belongs in the set. A layer of another theme is refused: a row is measured in one theme.
3. The foreground of such a row must be opaque. A translucent foreground moves with the ground under it and the bound below does not cover it.
4. The gate carries each extreme up through the stack — each layer's `saturate()` amount applied first, then the layer painted over the result — and measures the foreground on: every extreme as painted, **the darkest any blend can be**, **the lightest any blend can be**, and, for a material, the opaque fallback it paints when the glass is off. The row's ratio is the **minimum**. The existing thresholds apply unchanged: 4.5:1 for text, 3:1 for a boundary or an indicator.
5. If the foreground's luminance lies strictly between the darkest and the lightest blend, the row measures **1:1**: some blend matches the foreground, whatever the two ends measure.
6. A binding on an opaque background is refused, and a named set no row binds fails the gate: neither may sit in the register claiming a worst case that was never measured.
7. A gradient is the same case with nothing laid on top. A row whose `bg` is a gradient is measured over its stops and the bounds of every blend between them, with no set to bind; and every stop of a gradient that a glass theme paints must be a member of each backdrop set declared for that theme, or the materials are measured over a sky narrower than the one on screen.

`scripts/lib/backdrop.mjs` holds the maths. `test/backdrop-contrast.selftest.mjs` pins it by worked numbers and by brute force; `test/check-contrast.selftest.mjs` holds every refusal above.

## Why the extremes bound the worst case, and where they do not

- **Blur is a convex average.** A Gaussian blur replaces each pixel by a weighted mean of its neighbourhood, with non-negative weights that sum to 1. A blurred pixel is therefore a convex combination of the colours behind the surface: channel by channel it lies between the lowest and the highest value any backdrop has in that channel. No blur radius changes that; the radius only decides which combination.
- **Source-over is affine and increasing.** `alpha * tint + (1 - alpha) * under` moves each channel the same way the channel underneath moves, so a channel-wise bound on the backdrop is a channel-wise bound on the result.
- **Relative luminance is increasing in every channel.** So the luminance of anything the stack paints is at least the luminance of the box's floor: the colour made of the lowest value of each channel.

That floor is **not** one of the extremes, and this is the first limit of the informal statement "the extremes bound the worst case". A blend can be darker than both of its ends: pure red and pure blue average to a purple whose luminance (0.061) is below red's (0.213) and blue's (0.072), because blending happens on encoded values and luminance is convex in them. Measuring only the declared extremes would overstate the minimum for a dark foreground. The gate measures the floor as well. Upwards no extra point is needed: a convex function reaches its maximum over a hull at one of the points that span it, so the lightest blend is the lightest extreme.

The second limit is polarity. Contrast is not monotonic in the background across the foreground's own luminance: it falls to 1:1 as the ground approaches the foreground and rises again beyond. Two extremes on opposite sides of the foreground can each measure well while a blend between them matches it. Rule 5 is that case, refused as 1:1.

### Saturation boost

`saturate(s)` with `s > 1` is **not** a convex average. It is a linear map that pushes each colour away from its own grey, and it can push a channel outside the range the backdrops span, and outside the gamut, where it is clamped. An argument that covered blur alone would be wrong for every material that boosts saturation, which is all of the glass ones.

What makes it tractable is that the map is linear: it sends the convex hull of the backdrops onto the convex hull of their images. So the gate applies the CSS `saturate()` matrix to every extreme, with the amount the material declares, and bounds the result:

- while every image stays in gamut, the hull of the images is exact and the bound is as tight as without saturation;
- once an image leaves the gamut it is clamped, a clamp is not linear, and a hull stops being a hull. From that layer on the gate widens to the channel-wise box around the clamped images. The box still contains every colour the layer can paint, so the bound stays sound; it is looser.

### What the bound does not cover

- **Backdrops nobody declared.** The bound is over the set. A photograph, a video, user content or an embedded frame behind a glass surface can be any colour; the set has to hold the extremes of what is really painted there, and the only fully general set is black and white. A set is a claim about layout, reviewed like any other row.
- **A conservative floor.** For backdrops of very different hues the floor is darker than anything a blur can produce, so a row can fail on a ground that cannot occur. For the near-collinear sets this package declares — a sky gradient, a ramp of greys — the floor is within a rounding step of the darkest extreme. The error is always on the side of failing.
- **Translucent foregrounds**, refused (rule 3). A focus ring's halo on glass is not measured; its opaque indicator is.
- **Filters other than `blur()` and `saturate()`.** `brightness()`, `contrast()`, blend modes and `mix-blend-mode` are not modelled. The build emits only the two modelled functions, in the modelled order, blur first.
- **Native materials.** SwiftUI and UIKit materials and their vibrancy use vendor pipelines that are not the CSS filter chain. The native bindings export the parameters; a native surface that uses a system material instead of them is outside this bound and needs its own check.
- **Rendering detail.** The gate composites in encoded sRGB, as browsers do for these properties, and rounds each measured ground outwards by one step. It does not model dithering, wide-gamut displays, or a browser that blurs in another space.
- **Frame rate.** Whether a material can be drawn at all is a separate gate. This one says nothing about it.

## Options considered

| Option | Why not |
|---|---|
| **Chosen: explicit backdrop set, minimum over the extremes and the bounds of their blends** | The only shape that states a worst case and can be checked by brute force. Costs a declared set per glass canvas and a conservative floor. |
| Keep refusing every translucent background | Leaves every glass surface unmeasured, which a family built on glass turns into "no contrast gate". |
| Measure the tint as if it were opaque | Reports a ratio no user ever sees: the defect ADR-0002 closed for foregrounds, reintroduced for backgrounds. |
| Measure over the canvas colour only | True for one pixel of one screen. Content scrolls under a bar; a gradient has two ends. |
| Measure the declared extremes and nothing else | Wrong twice over, by the red and blue blend and by the foreground between two backdrops. The self-test keeps a brute-force search that beats this bound, so it cannot be mistaken for the chosen one later. |
| Let a row carry its own list of backdrops | Fail-open: a row on a themed surface could name the friendlier extremes and pass. A set is declared once, by name, for one theme, and the ground's own theme selects it. |
| Always measure over black and white | Sound and unusable: no translucent surface clears 4.5:1 over both, so every glass row would be allowlisted and the allowlist would be the design. |
| Ignore saturation as a small effect | A boost of 1.8 moves a sky blue's channels by tens of steps and out of gamut. It is modelled because it is linear and cheap to model, not argued away. |

## Consequences

- A glass surface is measurable, and the register says over what. A reviewer reads the set as a claim about what can pass behind the surface.
- Glass over dark content costs opacity. With the near-black rail in the `ciel` set, a white material needs an alpha of about 0.90 before tertiary ink clears 4.5:1 and about 0.92 before a control boundary clears 3:1. That is the design constraint the gate was asked to make visible, not a side effect of it.
- A wider set can only lower a row's minimum. Narrowing a set to make a row pass is a visible edit to `contrast-pairs.json`.
- Every row on a translucent background prints a second line naming the set and the worst ground, so the table says where each minimum came from.
- Revisit when a material needs a filter this does not model, when native materials replace the exported parameters, or when a tighter lower bound than the floor is worth a convex minimisation.
