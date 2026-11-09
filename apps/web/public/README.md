# `public/` — brand assets served as-is

Vite copies this directory to the root of the bundle without hashing or transforming it. A file
here is reachable at `/<name>`, which is why the paths below are absolute and why nothing in
`src/` should ever import them.

That includes this note: `public/README.md` is copied like everything else and will answer at
`/README.md` once the console is deployed. It says nothing that is not already public, but the
copy is all-or-nothing in Vite, so excluding it is a deployment concern, not a build option.

## Where these come from

All of it is the **Kodera** set: the nested-chevron monogram in white on the pure black tile, the
validated dark brand (`color.black` `#000000`, `color.white` `#FFFFFF` in the design-tokens
package). The vectors come from the internal design repository under `design/brand/kodera/`.

`favicon.svg` is the source of every raster here. `scripts/render-icons.py` reads its seven
paths, its group transform and its two fills, and writes the PNGs and the `.ico` (it needs Pillow,
at generation time only):

```sh
python3 scripts/render-icons.py
```

To change an icon, change `favicon.svg` and run the script. A pixel edited here by hand would be
silently reverted by the next run. `tests/unit/brand/icons-black.test.ts` decodes every PNG and
every `.ico` frame and checks the black ground, the mark and the safe zone.

| File | What it is |
|---|---|
| `favicon.svg` | The black tile with the white mark, 512 × 512, radius 25 %. Preferred by every browser that accepts an SVG icon; it stays sharp at any size and needs no second file. |
| `favicon.ico` | Rendered from `favicon.svg`, for the browsers and the bookmark bars that still ask for `/favicon.ico` by convention. Multi-frame: 16, 32, 48, each a PNG. |
| `icon-16.png`, `icon-32.png`, `icon-48.png` | The tile at the sizes a tab strip and a bookmark actually paint. Every raster is full-bleed and opaque, corner pixel `#000000`: the platform rounds the corners itself, and a transparent corner showed whatever lay beneath it. |
| `icon-180.png` | `apple-touch-icon`. iOS ignores the manifest for the home-screen icon and reads this tag instead; without it Safari screenshots the page. |
| `icon-192.png`, `icon-512.png` | The manifest icons: 192 for the launcher, 512 for the splash screen and the install prompt. |
| `icon-512-maskable.png` | The `purpose: "maskable"` variant: the same full-bleed tile, with the mark inside the central 80 % safe zone so Android can crop it to any platform shape without clipping it. |
| `site.webmanifest` | The web-app manifest. `theme_color` and `background_color` are both `#000000` (`color.black`, the tile), so the address bar, the splash screen and the icon share one ground. |
| `kodera-mark-slate.svg` | The bare monogram, seven paths, viewBox 463 × 608.663. Vector reference for the inline `KoderaMark` component in `src/ui/icons/KoderaMark.tsx`; the component reuses its paths. |
| `kodera-mark-white.svg` | The same seven paths filled white, byte-for-byte the design repository's `kodera-mark-white.svg`. The module rail draws it straight on its `c-inverse` ground, as the mock does. Slate on a light tile could not follow the theme: the tile turns dark in dark and black. |
| `theme.js` | Not a brand asset: the boot script that sets `data-theme` before the first paint (`docs/specs/10-appearance.md` §10). It is here because it must be a classic script at a fixed URL, and so it is **not hashed**, unlike the bundle it shares a storage key, an event name and a theme list with. Hosting must serve `/theme.js` with `Cache-Control: no-cache` (revalidate on every load): a copy cached for long would run an old contract against a new bundle. |
| `kodera-lockup-slate.svg` | Mark plus the outlined "KODERA" wordmark. Same rationale, for surfaces that name the maker. |

## What `index.html` carries

The application entry already links the icons and manifest below. Its blocking `/theme.js`
script runs before this markup to select the theme before the first paint. Keep this icon
contract aligned with `index.html`:

```html
<link rel="icon" href="/favicon.svg" type="image/svg+xml" />
<link rel="icon" href="/favicon.ico" sizes="48x48" />
<link rel="apple-touch-icon" href="/icon-180.png" />
<link rel="manifest" href="/site.webmanifest" />
<meta name="theme-color" content="#000000" />
```

Four things about that block are deliberate:

- **Both icon tags, in that order.** A browser that understands `image/svg+xml` takes the first
  and ignores the rest; one that does not falls back to the `.ico`. Shipping only the SVG loses
  the older browsers; shipping only the `.ico` gives everyone a blurry icon on a high-density
  screen.
- **`sizes="48x48"` on the `.ico`.** It stops Chrome from downloading and decoding the file merely
  to learn which frames it holds.
- **`apple-touch-icon` is not optional.** iOS does not read the manifest for the home-screen icon.
- **The `theme-color` hex is repeated here.** A `<meta>` tag takes a literal; it cannot read a
  token or a CSS variable. Keep `index.html`, this example and `site.webmanifest` aligned so
  the address bar and the splash screen agree. Nowhere else in the console may an inline colour appear: product code uses the shared
  tokens, and the token test enforces it.
