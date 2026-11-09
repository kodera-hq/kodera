# Built assets: cached and compressed

Status: specified, with its tests; staging qualification after release (`e2e/staging/public.spec.ts`).

## Why

The lead reported, after #350's release, an empty screen for 5–10 s on a direct load of `/kodera-team/home`. Measured in a visible browser tab on staging , on a fast connection and a warm connection cache:

| Step | Measured |
|---|---|
| Document parsed | 0.33 s |
| First paint, the session skeleton | 0.80 s |
| First content | 1.46 s |
| Largest content | 1.59 s |

- **The main script.** `main-*.js` is 2.94 MB on staging (2,937,492 bytes, its released build), and it was sent:
  - uncompressed, with no `Content-Encoding`;
  - with `Cache-Control: no-store`, like every other response.

  Every visit downloaded it whole again. That took 0.15 s on the fast connection. On a slower one, it is several seconds on every visit. This is an inference from the size: the lead's own connection was not measured.
- **A hidden tab.** A tab opened in the background paints nothing until it is shown. A measurement taken in one reads as a long empty screen: one such run painted first at 6.36 s, 0.27 s after the tab became visible at 6.09 s. Read `performance.getEntriesByType('visibility-state')` before trusting a first-paint time.

## The rule

`server/static.mjs`:
- **Assets are cached.** A file served from `/assets/` with status 200 carries:
  - `Cache-Control: public, max-age=31536000, immutable`;
  - `Vary: Accept-Encoding`.

  These names are content hashes from the build, so one name never serves two contents. The other security headers are unchanged: CSP, `Referrer-Policy`, `nosniff`.
- **Everything else stays unstored.** Every other response keeps `Cache-Control: no-store`:
  - documents and the SPA fallback (claim and invitation entries carry a secret in the address, `claim-entry-serving.md`);
  - `theme.js`, the manifest and the icons, which are not hashed;
  - every error, a missing asset included.
- **Compressed copies.** `npm run build` writes a brotli (`.br`) and a gzip (`.gz`) copy beside each text asset of 1 KiB or more, as its last step: `scripts/precompress.mjs`. Both builds that ship use that command, so both get the copies:
  - the image (`Dockerfile`);
  - staging, which builds in a checkout and serves `dist` with this server (deployment profiles's `core_release`).

  A copy is derived from a plain file and adds no content of its own. Both production-bundle scans, the image's and the release's read-back, run after the build and read the plain files (the image's reads the plain scripts under `assets/`). Measured on a built tree, the copies change neither scan's output, and none of the release's read-back strings occurs in a copy. A server given a tree without copies sends every file as it is (tested).
- **Choosing a copy.** The server sends a brotli or gzip copy when the request's `Accept-Encoding` takes that coding (RFC 9110 §12.5.3):
  - a coding is taken when it is named (`x-gzip` names gzip), or matched by `*`, with a nonzero weight;
  - `q=0` refuses a coding even where `*` would take it, and a repeated entry keeps its lowest weight;
  - an entry whose weight is not a single qvalue (0 to 1, at most three decimals) is ignored;
  - the coding with the higher weight wins, and brotli wins a tie;
  - otherwise the server sends the file as it is.
  - `Content-Type` is the source file's.
  - `HEAD` carries the same headers as `GET`.
- **Copies are not resources.** A copy is never served by its own name, in any letter case: a request for `/assets/x.js.br` is a 404 with `no-store`. Neither is any `/assets` path ending in a slash.

The copies are derived from the scanned files, and they carry no secrets. No response that holds per-member data or a secret is compressed or cached, so compression adds no BREACH-style exposure.

## Measured on a local build

The local build is the mock build the visual suite uses (2,863,720 bytes for the main script, against staging's 2,937,492), compressed by `scripts/precompress.mjs`:

| File | Plain | Brotli | Gzip |
|---|---|---|---|
| `main-*.js` | 2,863,720 bytes | 619,971 bytes (−78 %) | 786,797 bytes |
| The crypto `.wasm` | 7,805,486 bytes | 1,444,508 bytes | 2,091,077 bytes |

The crypto `.wasm` is needed by the workspace only.

## Acceptance

`npx vitest run tests/unit/serving`, against the real server and real files, covers:
- the asset cache and `Vary`;
- `no-store` on documents, on the SPA fallback and on a missing asset, even when the request accepts compression;
- each `Accept-Encoding` case, with `q=0` and `*`, for `GET` and `HEAD`, and the decompressed body equal to the file;
- a file with no copy sent as it is;
- a direct request for a copy refused.

Mutation `M10` (the asset rule widened to every response) is caught by the document's `no-store` check.

`tests/unit/serving/precompress.test.ts` covers:
- which files get copies, and that they decompress to their source;
- the refusal to run twice;
- that `npm run build` compresses as its last step, and that the image only scans that build and never compresses a second time.

After a release, `e2e/staging/public.spec.ts` checks:
- that the document is `no-store`;
- that its entry script comes cached and compressed.

## Not in this change

The size of the main script itself. It could be split by route; that is a separate change, measured on its own.
