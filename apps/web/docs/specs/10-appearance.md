# 10 — Appearance

**Status:** Proposed · **Owner:** zôÖma

## 1. Goal

Let a person read the console in the light their eyes and their screen need — light at the office,
dark at the end of the day, black on an OLED phone at night — or simply as their device is set.

## 2. Persona and the "can the CEO do this alone" test

**Who.** Anyone with an account, whatever their role: the theme is a person's comfort, not an
organisation's setting. Most never open this page, because the console already follows the
light or dark setting of their device. The one who does has a reason: the device is dark and they
want the console light, or they want the black theme on a phone.

**Alone test: pass.** The page is one choice between six cards, each drawn in the theme it names,
and the choice applies at once, so the person sees the result before leaving the page. Nothing
needs saving and nothing can be lost.

**Where it still fails.** The choice belongs to the browser, not to the person: on another device,
or in another browser, the console follows that device again until the person chooses there too.
The page says so. Keeping the choice with the account is planned after launch (§13).

## 3. Entry points

| Entry | URL |
|---|---|
| Account menu, wide layout: « Apparence », after « Sécurité et connexion » | `/{org}/appearance` |
| « Plus » sheet, narrow layout: « Apparence », after « Sécurité et connexion » | `/{org}/appearance` |
| Deep link | `/{org}/appearance` |

The entry is one item of the account list both layouts draw from (`src/app/accountItems.ts`,
[`00-shell-and-login.md`](00-shell-and-login.md) §4.5). On a phone it is a place, so it goes to
« Plus » with the other places, not to the top menu that holds the session (, owner ruling). The page sits under the organisation so the shell is drawn around it; the choice
itself is not the organisation's.

## 4. Screens

### 4.1 `appearance`

```text
┌───────────────────────────────────────────────────────────────────────────┐
│  Apparence                                                     (h1)       │
│  Thème de la console                                                      │
│                                                                           │
│  Le thème s'applique immédiatement à toute la console. Il est enregistré  │
│  dans ce navigateur seulement : sur un autre appareil ou un autre         │
│  navigateur, choisissez-le à nouveau.                                     │
│  ┌═══════════════┐ ┌───────────────┐ ┌───────────────┐ ┌───────────────┐  │
│  ║ ▒▒│░░░ ▓▓│███ ║ │ ░░│    ▬▬     │ │ ▓▓│████ ▬▬    │ │ ██│████ ▬▬    │  │
│  ║ Automatique   ║ │ Clair         │ │ Sombre        │ │ Noir          │  │
│  ║ suit le       ║ │ bureau, plein │ │ faible lumi-  │ │ écrans OLED,  │  │
│  ║ réglage …     ║ │ jour          │ │ nosité, …     │ │ usage nocturne│  │
│  └═══════════════┘ └───────────────┘ └───────────────┘ └───────────────┘  │
│  (« Ciel » and « Ciel nuit » sit between « Automatique » and « Clair »)   │
│  (warning, only when the browser refused to keep the choice)              │
└───────────────────────────────────────────────────────────────────────────┘
```

The delivered design's Réglages › Vous › Apparence pane, its theme cards only.

- **Six cards, one choice**, in this order: « Automatique » (the default), « Ciel », « Ciel nuit »,
  « Clair », « Sombre », « Noir ». « Automatique » follows the device inside the default family,
  Ciel (packages/design-tokens/docs/specs/ethereal-sky-glass.md, owner decision B2): « Ciel » on a
  light device, « Ciel nuit » on a dark one. The Givre themes stay one click away. The mock draws
  the last three; « Automatique », which follows the device, is an owner-approved deviation from
  the mock (plan D4), and the two Ciel cards follow the same decision.
- **A card:** a 56 px preview, the theme's name (13 px, 600) and the mock's hint (`text-xs`, the
  type scale's smallest step). The preview draws the theme's own page strip, surface and primary
  action colour, scoped with `data-theme` on the preview, so it cannot drift from the theme it
  names; « Automatique »'s preview is half « Ciel », half « Ciel nuit ».
- **The chosen card** has a 2 px `c-accent-ink` edge and a `c-accent-ink` name; the others a 1 px
  `c-border` edge. The mock draws the chosen edge in `c-action`; `c-accent-ink` follows the
  owner-approved chosen-edge ruling of the plan cards , taken when `action` was
  2.88 : 1 against the dark card, under WCAG 1.4.11. Tokens v0.5.0 raise it to 3.54 : 1, and the
  ruling stands until the owner revisits it.
- **Layout:** as many columns of at least 220 px as fit; one column in the narrow layout.
- **Not drawn:** the mock pane's density and text-size rows, and its « Enregistrer » action — the
  console has neither setting, and a choice applies without saving.

Delivered components: the mock's theme card, drawn by each radio item itself with the page's own
classes, not the `Card` component. Console primitives: `InlineAlert`. The radio group is Radix's
(`@radix-ui/react-radio-group`) used directly, not the console's `RadioGroup`, whose items are a
dot and a label rather than a card.

## 5. State matrix

| State | `appearance` |
|---|---|
| Default | The six cards; the stored choice checked, or « Automatique » when none is stored or the stored value is not a theme. |
| Loading | Not reachable: the page reads nothing from the network, only this browser's storage. |
| Empty | Not reachable: there are always five themes and « Automatique ». |
| Error | The browser refuses to store the choice (private mode, a policy, a full storage): the choice still applies to this page until the next load, and an `InlineAlert` (`warning`) under the cards says it will not be kept, then how to keep it. Opened again before that load, the page shows the same choice checked and the same warning: it shows the choice the page wears, never an older stored one. |
| Success | The page changes theme at once and the chosen card is checked; no `Toast`, the page itself is the confirmation. |
| Partial failure | The error row above is the one partial case: applied, not kept. |
| Permission denied | Not reachable: every role has an account and chooses its own theme. |
| Offline | The page works unchanged; it makes no request. |

## 6. Core API calls

None. The choice is stored in this browser (`localStorage`, key `console:theme`) and never sent:
server-side persistence waits for the settings of the account (plan D4, §13).

## 7. MSW scenario overlays

None of its own. The tests sign in with `shell.single-organisation` and `home.default`.

## 8. Validation rules

None: the only input is a choice between six cards. A stored value that is not one of the five
themes — an old version's, another tool's, a hand edit — is read as « Automatique », on this page
and by `public/theme.js` before the ordinary application is released after verified URL cleanup.

## 9. Error copy rules

Cause, then the next action, in one sentence pair: the browser did not keep the choice, it applies
to this page only; to keep it, allow the site to store data in the browser's settings
(`console.shell.appearance.warning-not-kept`). No API error codes apply.

## 10. Accessibility

- **Before the ordinary application.** After verified URL cleanup, the external bootstrap loads
  `public/theme.js` as a classic script and awaits its successful load/application before
  importing the real main module and calling `boot`. It sets `data-theme` on `html` from the
  stored choice or the device's `prefers-color-scheme`, and follows the device's changes while
  « Automatique » is chosen, in Ciel: « Ciel » on a light device, « Ciel nuit » on a dark one. The
  browser's own parts (scrollbars, native controls) follow with `color-scheme: dark` in dark,
  black and « Ciel nuit ».
- **Focus order:** page `h1` → the radio group (one stop, on the checked card) → the warning, when
  present, is not focusable. It is announced: its `role="status"` region is on the page, empty,
  from the start, and the warning is put inside it, since a polite region inserted with its
  message already in it is often not read.
- **Keyboard map:** `Tab` reaches the group once, on the checked card; `→`/`↓` and `←`/`↑` move to
  and choose the next or previous card, wrapping round. Moving is choosing, as for any radio group.
- **Names:** the group is « Thème », described by the line above it; each card is named by its
  label alone and described by its hint. The previews are hidden from assistive technology.
- **Focus ring:** the themed ring, 2 px off the card's edge (`focus-offset`), so it meets 3 : 1
  against the ground whatever the edge's colour; checked drawn in each theme.
- **Every theme passes axe, contrast included**, on this page and on every launch view
  (`tests/visual/screens.spec.ts`), without rule exclusions. The end-to-end suite runs twice, on a light
  device and on a dark one (`playwright.config.ts`), so every axe check it carries is also a check
  of « Ciel nuit », the theme a dark device gets by default. The visual baselines choose Givre
  light explicitly, so they keep guarding the Givre themes now that Ciel is the default. The unit test `tests/unit/e2e-projects.test.ts`
  fails if the dark project is dropped or turned light, if a test runs in one project only, or if
  `npm run test:e2e` or the CI step calling it filters the suite. The chosen state is carried by more than colour
  (edge width and `aria-checked`).
- **Inverse cards keep their shape.** In black the inverse ground is the page's own colour
  (`#000000`) and in dark nearly so (`#0C1116` on `#10151B`), so the contract and support cards on
  Accueil, and every other `Card` in the inverse tone, draw a 1 px `c-border` edge in dark and
  black. Light draws none, and no light screen moves (`inverse-edge` in `src/index.css`;
  owner-approved deviation from the mock).

## 11. Analytics events

None. Choosing a theme sends nothing: it is a matter of comfort, stays in the browser, and
counting it would be the one request this page makes.

## 12. Acceptance tests

1. **Given** a device set to dark, then to light, then a stored choice of black on a dark device,
   **when** the console loads and the same page is reloaded for each changed preference,
   **then** `data-theme` is `ciel-nuit`, `ciel`, then `black` while the real main module response is still
   withheld; the real theme resource completes before main is requested, and the original main
   response is then continued and the application boots.
   `appearance/boot: applies the selected theme before the real main response, from the choice or the device`

2. **Given** a device set to dark and no theme chosen,
   **when** the device turns light, the person chooses « Sombre », the device changes twice, and
   the person chooses « Automatique »,
   **then** the page follows the device (`ciel-nuit`, then `ciel`), holds dark while « Sombre » is
   chosen whatever the device says, and follows the device again once « Automatique » is chosen.
   `appearance/page: follows the device only while Automatique is chosen`

3. **Given** a stored theme the console does not know (`sepia`) on a dark device,
   **when** the page loads,
   **then** « Automatique » is checked and the page is `ciel-nuit`.
   `appearance/page: reads an unknown stored theme as Automatique`

4. **Given** the Apparence page and a light device,
   **when** the person uses the keyboard alone: `Tab` to the group, then `→` five times, then `Tab`,
   **then** focus lands on the checked « Automatique » with a visible ring, each arrow checks the
   next card and applies its theme at once, the next `Tab` leaves the group, and « Noir » is still
   chosen and applied after a reload.
   `appearance/page: chooses a theme with the keyboard alone and keeps it after a reload`

5. **Given** a browser that refuses to store the choice,
   **when** the person chooses « Noir »,
   **then** the page turns black, a warning says the choice will not be kept and how to keep it,
   the page passes axe, and after a reload the page follows the device (`ciel`) with
   « Automatique » checked.
   `appearance/page: says the choice is not kept when the browser refuses to store it`

6. **Given** the Apparence page,
   **when** it is shown in each of the five themes with the chosen card focused from the keyboard,
   **then** it passes axe in each, contrast included, the focus ring is drawn, and the page's
   `color-scheme` is `normal` in « Ciel » and light and `dark` in « Ciel nuit », dark and black.
   `appearance/page: passes axe in every theme`

7. **Given** a signed-in person on a desktop, then on a 390 × 780 screen,
   **when** they choose « Apparence » in the account menu, then in the « Plus » sheet,
   **then** each opens `/{org}/appearance`, the sheet lists it after « Sécurité et connexion », and
   « Plus » is drawn as current on the page.
   `appearance/entry: opens from the account menu on a desktop and from Plus on a phone`

8. **Given** Accueil with its contract and support cards on a desktop,
   **when** the person chooses « Clair », then « Sombre », then « Noir » and opens Accueil each time,
   **then** both inverse cards have no edge in light, and a 1 px solid edge in the theme's
   `c-border` on every side in dark and in black.
   `appearance/themes: outlines the inverse cards in dark and black, and not in light`

9. **Given** the end-to-end suite's two projects, one on a light device and one on a dark device,
   **when** the console loads in each,
   **then** `data-theme` is the device's, so the dark project's checks are checks of the dark
   theme and not a second pass over light, and the suite declares one light and one dark device.
   `appearance/suite: draws the console in the theme its project’s device asks for`

## 13. Out of scope for launch

- Keeping the choice with the account, so it follows the person to every device (planned after
  launch, with the account's settings).
- The mock pane's message-list density and text size: the console has neither setting (not
  planned; they belong to the messaging application).
- A theme per organisation, or an organisation's colours in the console (not planned: the theme is
  a person's comfort; an organisation's branding is its sign-in page's, in `00-shell-and-login.md`
  §13).

## Changelog

- The light/dark suite guard ships negative fixtures for missing or downgraded projects, asymmetric
  discovery, and filtered npm or workflow commands. Each fixture must name the refused condition.
  Discovery covers static exclusions; runtime conditional skips remain outside this guard.

- A choice the browser refused stays the page's until the next load, and the page shows it, warning
  included, when opened again; the warning's live region is mounted empty so it is announced;
  the end-to-end suite runs on a dark device as well (, owner ruling), guarded by
  acceptance test 9 and by `tests/unit/e2e-projects.test.ts`; test 6 also checks `color-scheme` and the focus ring per theme; the hint
  names another browser as well as another device.

- Inverse cards outlined in dark and black: a 1 px `c-border` edge on every inverse `Card`, where
  the inverse ground is the page's own colour or nearly; light unchanged (, owner ruling).
  Acceptance test 8.

- Initial version: the Apparence page with four theme cards (« Automatique » the default,
  owner-approved deviation from the mock), reached from the account menu and the « Plus » sheet;
  the theme applied before the first paint and following the device while « Automatique » is
  chosen; the choice kept per browser. Supersedes the plan's account-menu item that cycled through
  the themes.
