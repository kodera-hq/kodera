# Icon-only controls

Status: Implemented for independent review; service release remains separate.

## Spec

zôÖma's decision, with the approved dark reference screens: icons only, no visible text labels by default, for a lighter interface « less full of information everywhere ». A control's name shows on hover and on focus as a tooltip and stays its accessible name.

This slice covers the two places the decision names:

- **The module rail** (`src/app/ModuleRail.tsx`, and the `Rail` primitive in `src/ui/Rail`): each destination (the tenant's applications, « Messages », « Réglages ») is a 48 px icon square. Its name is its `aria-label`, as before, and its tooltip, drawn to its right, 20 px out, so it sits past the rail's dark column on the sidebar's ground. No `title`: it would draw the browser's own tooltip over the rail's. The current item keeps its plate, its bar and `aria-current="page"`; an application that opens elsewhere keeps « s'ouvre dans un nouvel onglet » in its accessible name.
- **The call dock** (`src/ui/AudioDock`): « Couper le micro », « Couper le son » and « Quitter » are icons only in the sidebar as on the phone banner; the labels no longer run into each other in the sidebar's 264 px. Each label is the button's `aria-label` and its tooltip, above it. Mute and deafen keep `aria-pressed` and their struck-through glyph; « Quitter » stays the only red control. The sidebar's controls are 40 px tall, with the 44 px floor on a narrow screen; the banner's stay 52 px. « Revenir à l'appel », already icon-only, gets the same tooltip.
- **Other icon-only controls of the shell** get the same tooltip: the maker's mark at the rail's top (« Accueil de … ») and the header's sidebar toggle (« Masquer la navigation » / « Afficher la navigation », following its state).

`Tooltip` (`src/ui/Tooltip`) gains `names`, for a tooltip that restates its trigger's name:

- it is drawn for the eye only (`aria-hidden`), and Radix's `aria-describedby` from the trigger to it is taken back off, so a screen reader reads the name once, not as the name and again as a description (WCAG 4.1.2). A description the trigger sets itself is kept;
- it shows after 300 ms under the pointer, not Radix's 700 ms, and at once on keyboard focus;
- `Escape` hides it without moving the focus, the pointer can move onto it, and it stays until the pointer or the focus leaves (WCAG 1.4.13); focus rings are unchanged (WCAG 2.4.7).

A touch screen shows no tooltip (Radix does not open one on touch); the accessible name is unchanged there, and the phone banner was already icon-only.

Not in this slice:

- a tooltip on the icon-only triggers of a popover (« Réglages audio » in the dock, « Insérer un émoji » in the composer): a tooltip's trigger and a popover's trigger on one element both set `data-state`, and the popover's open state, which the emoji trigger is drawn from, would be overwritten. They keep their accessible names; their tooltips need a composed trigger, a follow-up;
- the message actions (« ··· », the reaction palette), already icon-only and named: they are a menu's and a popover's triggers, the same case as above.

Kept labelled: the search field « Rechercher » (a field's placeholder, as Discord draws it), category disclosures and the thread link « N réponses » (their text is content), and « Tester le son », a one-off action inside the roomy audio settings panel, where its label costs nothing and an icon alone would read as an output control. The phone tab bar keeps its labels under its glyphs (the usual phone pattern; it is also reworked in a separate draft).

### Second slice: the composer and the page title

- **Send** (`src/features/espace/EspaceLiveView.tsx`): « Envoyer » is an icon-only button, « Enregistrer » while a message is being edited. The word is its `aria-label` and its tooltip. Enter still sends; the button stays the form's submit button, a 32 px square on the primary fill.
- **`Button iconOnly`** (`src/ui/Button`): a square as wide as it is tall at each size, holding `icon` and no label, named by a required `aria-label` and drawn with a `names` tooltip. It refuses to draw without an icon or a name, and with `asChild`.
- **« Mentionner »** in the composer and the thread panel's close button get the same tooltip.
- **The space between words** (`src/index.css`, the base layer): on staging, « Bonjour zôÖma » read as one word and a 600-weight button read « Voirles applications ». The space is in the text (U+0020, measured in the signed-in browser), but Plus Jakarta Sans draws a narrow space: 0.178 em in every weight, measured in the font files. The page title's tight tracking (−0.045 em) left it 4 px at 30 px. A base rule widens the space alone by 0.08 em, on every element so that it scales with each element's own size (an `em` length set on `html` is inherited as pixels). It belongs in the tokens package with the font family, as a word-spacing token, and moves there once one is published. Every screen's text spacing moves slightly, so every visual baseline moves.

No new API response, message key or token. The tokens package's `shell-rail-item-width` (68 px, sized for a label) is no longer used by the console.

## Acceptance

Second slice: `npx vitest run src/ui/Button src/ui/ThreadPanel src/features/home/GreetingHeader.test.tsx src/features/espace/EspaceLiveView.test.tsx`. The send button has no text and is named « Envoyer » (« Enregistrer » while editing); clicking it and Enter both send. `iconOnly` is a square with its name as a tooltip, read once, and refuses to draw without a name or an icon. « Mentionner » and « Fermer le fil » show their names as tooltips. The greeting's text keeps its space, and in Chromium the gap between the words of the title and of a 600-weight action is at least 0.2 em (`npx playwright test tests/e2e/08-home.spec.ts -g "visible space"`; it measured 0.133 em without the rule).

First slice:

Run `npx vitest run src/ui/Tooltip src/ui/Rail src/ui/AudioDock src/app/ModuleRail.test.tsx src/app/Shell.landmarks.test.tsx src/ui/stories-a11y.test.tsx`, and `npx playwright test tests/e2e/shell-fidelity.spec.ts tests/e2e/module-rail.spec.ts` for the real router in a real browser.

- The rail's items and the dock's controls have no text content; each is named by its `aria-label`, and the rail's carry no `title`.
- Focus on a rail item (with `asChild` too), the maker's mark, the sidebar toggle or a dock control shows its name as a tooltip at once; the control's accessible description stays empty; `Escape` hides the tooltip and the focus stays. The pointer shows it too. The dock's controls keep the 44 px floor on a narrow screen.
- `names` tooltips are absent from the accessibility tree, take no `aria-describedby`, keep the trigger's own description, and show under the pointer at 300 ms, not before (a fake clock). Removing the `aria-describedby` override or the `aria-hidden`, or moving the delay to 280, 320 or 700 ms, each fails a case.

## Evidence

Exact-head checks, the mutation results and independent findings are recorded with the pull request.
