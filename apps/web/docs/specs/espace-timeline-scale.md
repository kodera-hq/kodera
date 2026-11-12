# Espace timeline at scale

Status: Implemented for independent review; service release remains separate.

## Spec

### Virtual log

A channel's log can hold ten thousand messages. Only the rows on screen and a margin of `OVERSCAN_ROWS` (8) on each side are in the page, and never more than `MAX_DRAWN_ROWS` (60), whatever the screen's height. Two spacers above and below the drawn rows stand in for the others. Each spacer is as tall as its rows' measured heights, or their estimates before a row was ever drawn. The scrollbar and the member's place therefore stay true.

- **Window.** The arithmetic is a pure function, `timelineWindow` in `src/features/espace/timelineWindow.ts`. It uses prefix-sum offsets and a binary search, so layout costs O(n) once per change and O(log n) per scroll. When the cap leaves room for only part of the margin, that margin is shared evenly above and below. A screen taller than the cap keeps the rows that are on screen.
- **Measuring.** Measurement lives in `src/features/espace/timelineVirtualizer.ts`, a small store the log subscribes to with `useSyncExternalStore`.
  - Each drawn row is measured after layout. When a row above the screen changes height, the log moves by the same difference, so the text being read stays in place.
  - A log that is following its newest message stays at the end.
  - The window is read again inside the scroll event and drawn synchronously, so no frame is blank.
  - Spacer heights are set through the CSSOM, never through a `style` attribute: the policy sends `style-src-attr 'none'`.
- **Rows.** Each row carries its own 8 px top gap, so a row's measured height is all the space it takes. The log sets `overflow-anchor: none`, so the browser's scroll anchoring does not interfere with this one.
- **Opening a message.** `MessageTimeline` exposes `showMessage(eventId)` through `handleRef`.
  - It draws the row, centres it, marks it for 1.6 s, and focuses it without scrolling.
  - It returns false for a message that is not in the loaded history.
  - Pinned messages and search results jump to their message through this handle.
- **Update cost.** The rows' tops are kept until the rows or a measured height change. The calendar day of a message is cached per quarter hour, because `Intl` date parts cost about 5 µs per message. The reply index is cached per timeline array.

### Device cache

A channel opens on what it last showed, before the first sync answers (`src/features/espace/matrix/timelineCache.ts`).

- **What is kept.** For each room, the newest 200 message views that the homeserver has acknowledged. No token, no raw event, and no pending or failed message is kept. Records are keyed by member and room, so one member never reads another's.
- **When it is written.** A room's changes are written 750 ms after a burst of events, one write per burst. A stopping store writes what is waiting.
- **When it is shown.** The store reads the cache at start and does not wait for it. A room's cached messages are shown until that room's first sync replaces them. The cache fills a first screen; it is not a second history.
- **When it goes.**
  - A room the member leaves is forgotten.
  - When the Matrix session ends (a sign-out, a refused refresh, or another sign-in in this tab), every record is wiped, and a write still waiting never lands. If clearing fails, the whole database is deleted instead.
  - The console's sign-out (`auth/localSession.ts`) deletes the database by name, whether or not Espace was opened in the tab.
  - A member's store, as it starts, deletes every record that is another member's, older than 14 days, or filed under a key that is not its own.
  - A browser without IndexedDB, or one that refuses it, keeps nothing and loses no message.
- **Reading back.** Every record is checked field by field. A record of another version, shape or member is ignored.

### Pinned messages

A room's pins are its `m.room.pinned_events` state, read by the store (`getPinned`), in the order the room keeps them. Only event ids are read, each once.

- **Pinning.** The message menu offers « Épingler » or « Désépingler » where the room's power levels let the member send that state (`canPin`). Archived channels, deleted messages and thread replies offer neither. Pinning sends the whole list with the event added or removed. A refused change leaves the room's list as it was, and that list is what shows.
- **The list.** A header button names how many pins the room has. Its popover lists them, the most recently pinned first. Each entry shows the author, the time and one line of the message. A pin older than the loaded history is listed as such.
- **Jumping.** Choosing an entry closes the popover and brings the message into sight through `showMessage`. The row is marked and takes the focus, rather than the trigger.

### Search

A header button opens a field that searches the channel's loaded messages (`searchMatching.ts`). It does not use the homeserver's search: history is searched as far back as it is loaded.

- **Matching.** Every word of the query must appear in the message's text or its author's name, ignoring case and accents. A query shorter than two characters searches nothing. Deleted messages never match.
- **Results.** At most 50, newest first; a line says when more matched. The count is announced in a polite status. The list follows the field through `useDeferredValue`, so typing stays responsive in a long channel. Each message's folded text is computed once.
- **Jumping.** Choosing a result works like choosing a pin.

### Kodera emoji

Kodera has eight emoji of its own, written `:kodera_mark:`, `:kodera_heart:`, `:kodera_check:`, `:kodera_spark:`, `:kodera_coop:`, `:kodera_sky:`, `:kodera_sun:` and `:kodera_wave:` (`koderaShortcodes.ts`). No Unicode emoji writes them, so a message's body keeps the code, and another Matrix client shows it as text.

- **Drawing.** Kodera draws an exact, known, lower-case code as its glyph: an inline SVG at the text's size. The glyph has no colour of its own; it takes `currentColor`, coloured by the accent ink role, so it follows every theme. Its accessible name and tooltip are its code. An unknown code, another case, or a Unicode shortcode stays text, and the text around it keeps its inline Markdown.
- **Loading.** The glyphs are a separate chunk (`KoderaEmojiGlyphs.tsx`, under 1 kB gzip), fetched the first time one is drawn. Until then the code shows. If the chunk cannot be fetched, the code stays: a message is never lost for a glyph.
- **Writing.** The composer's palette lists the eight after the 32 Unicode emoji, under « Émojis Kodera ». The grid keeps one tab stop, and `End` reaches the last Kodera emoji. Choosing one writes its code at the caret.

## Acceptance

Run `npx vitest run src/features/espace` and `npx playwright test -c playwright.espace.config.ts tests/espace/layout/scale.spec.ts tests/espace/layout/cache.spec.ts`.

- `timelineWindow.test.ts` pins the window rules: an empty log, a short log, the cap, the shared margin, a screen taller than the cap, estimate against measured height, and a layout of 10,000 rows under 4 ms (median).
- `EspaceLiveView.renders.test.tsx` asserts that no mount draws more than `MAX_DRAWN_ROWS` rows, and keeps its draw-count proofs within the window.
- `scale.spec.ts` runs in a real browser over a fake store with 10,000 messages:
  - The channel opens on the newest message with at most 60 rows drawn.
  - A new message is drawn within a frame: median under 16 ms over the appends, measured around the synchronous publish.
  - The log scrolls back to its first message.
- `timelineCache.test.ts` covers the cache over a map: the 200-message cap, sent messages only, one write per burst, member isolation, rejected shapes, a copy taken at save, forgetting a room, writing on stop, the wipe that cancels a waiting write, and refused storage.
- `store.cache.test.ts` runs the real SDK against a fake homeserver. Cached messages are shown before the first sync, the live room replaces them and is then kept, and a sign-out wipes the cache.
- `searchMatching.test.ts` covers folding, the two-character floor, all-words matching by text and author, deleted messages, the 50-result cap, and 10,000 messages searched within a frame.
- `store.pins.test.ts` runs the real SDK. Pins are read from the room's state, ids only and once each; pinning sends the whole list; nothing is sent for a pin already there; and a stopped store lets no one pin.
- `EspaceLiveView.pins.test.tsx` pins and unpins from the menu, hides the item from a member without the right, lists pins latest first with the unloaded one said, finds messages regardless of accents, and focuses the message chosen.
- `koderaShortcodes.test.ts`, `MessageText.test.tsx` and `EspaceLiveView.emoji.test.tsx` cover the emoji. Only exact known codes are cut out, and every code has a glyph and no glyph lacks one. A glyph is drawn, named by its code, with no colour literal, while unknown codes, Unicode codes and Markdown around them stay as sent. The palette offers the eight after the others, writes and sends the code, and `End` reaches the last.
- `cache.spec.ts` runs on the browser's real IndexedDB. A room is read back at 200 messages for its member and for no one else, and ending the Matrix session wipes every record.

## Evidence

Measured on a development build in Chromium with the harness above: the median draw of a new message is about 8 ms over 10,000 messages. Before the caches it was 52 ms. Exact-head checks are recorded with the pull request.
