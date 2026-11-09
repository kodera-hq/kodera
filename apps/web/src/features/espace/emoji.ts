// Emoji in the composer: « :nom: » shortcodes, written as the emoji itself before a message is
// sent, so the stored body carries the emoji and every client shows it; and the composer's emoji
// palette. Pure functions: the field is `MentionInput.tsx`, the palette `EmojiPalette.tsx`.
// Received text is never reinterpreted: a « :wave: » someone else sent stays as they sent it.

import { linkSegments } from './MessageText'

/** One emoji and the shortcodes that write it, the first being the one the lists show. */
export interface EmojiShortcode {
  emoji: string
  names: readonly string[]
}

/**
 * The shortcodes the composer knows: the common names Discord, Slack and GitHub share, in
 * English as they all write them. A curated set, not the Unicode list: no new dependency, and
 * the first 32 are the palette's, in its order.
 */
export const EMOJI: readonly EmojiShortcode[] = [
  { emoji: '👍', names: ['thumbsup', '+1', 'thumbs_up'] },
  { emoji: '❤️', names: ['heart'] },
  { emoji: '😂', names: ['joy'] },
  { emoji: '🎉', names: ['tada'] },
  { emoji: '👀', names: ['eyes'] },
  { emoji: '✅', names: ['white_check_mark'] },
  { emoji: '🙏', names: ['pray'] },
  { emoji: '😮', names: ['open_mouth'] },
  { emoji: '😀', names: ['grinning'] },
  { emoji: '😄', names: ['smile'] },
  { emoji: '😊', names: ['blush'] },
  { emoji: '🙂', names: ['slight_smile', 'slightly_smiling_face'] },
  { emoji: '😉', names: ['wink'] },
  { emoji: '😅', names: ['sweat_smile'] },
  { emoji: '🤣', names: ['rofl'] },
  { emoji: '😍', names: ['heart_eyes'] },
  { emoji: '🤔', names: ['thinking'] },
  { emoji: '😎', names: ['sunglasses'] },
  { emoji: '😢', names: ['cry'] },
  { emoji: '😭', names: ['sob'] },
  { emoji: '😡', names: ['rage'] },
  { emoji: '😴', names: ['sleeping'] },
  { emoji: '👋', names: ['wave'] },
  { emoji: '👏', names: ['clap'] },
  { emoji: '🙌', names: ['raised_hands'] },
  { emoji: '💪', names: ['muscle'] },
  { emoji: '👎', names: ['thumbsdown', '-1', 'thumbs_down'] },
  { emoji: '👌', names: ['ok_hand'] },
  { emoji: '🔥', names: ['fire'] },
  { emoji: '🚀', names: ['rocket'] },
  { emoji: '💯', names: ['100'] },
  { emoji: '☕', names: ['coffee'] },
  { emoji: '😁', names: ['grin'] },
  { emoji: '😆', names: ['laughing'] },
  { emoji: '😇', names: ['innocent'] },
  { emoji: '🥰', names: ['smiling_face_with_3_hearts', 'smiling_face_with_three_hearts'] },
  { emoji: '😘', names: ['kissing_heart'] },
  { emoji: '😋', names: ['yum'] },
  { emoji: '😜', names: ['stuck_out_tongue_winking_eye'] },
  { emoji: '🤗', names: ['hugging', 'hugs', 'hugging_face'] },
  { emoji: '🤫', names: ['shushing_face'] },
  { emoji: '🤐', names: ['zipper_mouth', 'zipper_mouth_face'] },
  { emoji: '😐', names: ['neutral_face'] },
  { emoji: '😏', names: ['smirk'] },
  { emoji: '🙄', names: ['rolling_eyes'] },
  { emoji: '😬', names: ['grimacing'] },
  { emoji: '😌', names: ['relieved'] },
  { emoji: '😔', names: ['pensive'] },
  { emoji: '😷', names: ['mask'] },
  { emoji: '🤒', names: ['thermometer_face'] },
  { emoji: '🥳', names: ['partying_face'] },
  { emoji: '🥺', names: ['pleading_face'] },
  { emoji: '😕', names: ['confused'] },
  { emoji: '😟', names: ['worried'] },
  { emoji: '😲', names: ['astonished'] },
  { emoji: '😳', names: ['flushed'] },
  { emoji: '😱', names: ['scream'] },
  { emoji: '😤', names: ['triumph'] },
  { emoji: '😩', names: ['weary'] },
  { emoji: '🤯', names: ['exploding_head'] },
  { emoji: '🤝', names: ['handshake'] },
  { emoji: '✌️', names: ['v'] },
  { emoji: '🤞', names: ['crossed_fingers'] },
  { emoji: '👉', names: ['point_right'] },
  { emoji: '👈', names: ['point_left'] },
  { emoji: '👆', names: ['point_up_2'] },
  { emoji: '👇', names: ['point_down'] },
  { emoji: '✋', names: ['raised_hand'] },
  { emoji: '🤷', names: ['shrug'] },
  { emoji: '🤦', names: ['facepalm'] },
  { emoji: '🧡', names: ['orange_heart'] },
  { emoji: '💛', names: ['yellow_heart'] },
  { emoji: '💚', names: ['green_heart'] },
  { emoji: '💙', names: ['blue_heart'] },
  { emoji: '💜', names: ['purple_heart'] },
  { emoji: '💔', names: ['broken_heart'] },
  { emoji: '✨', names: ['sparkles'] },
  { emoji: '⭐', names: ['star'] },
  { emoji: '⚡', names: ['zap'] },
  { emoji: '💡', names: ['bulb'] },
  { emoji: '📌', names: ['pushpin'] },
  { emoji: '📎', names: ['paperclip'] },
  { emoji: '📅', names: ['date'] },
  { emoji: '📝', names: ['memo', 'pencil'] },
  { emoji: '📣', names: ['mega'] },
  { emoji: '🔔', names: ['bell'] },
  { emoji: '🔒', names: ['lock'] },
  { emoji: '🔑', names: ['key'] },
  { emoji: '🐛', names: ['bug'] },
  { emoji: '🛠️', names: ['hammer_and_wrench', 'tools'] },
  { emoji: '⚠️', names: ['warning'] },
  { emoji: '❌', names: ['x'] },
  { emoji: '❓', names: ['question'] },
  { emoji: '❗', names: ['exclamation'] },
  { emoji: '➕', names: ['heavy_plus_sign'] },
  { emoji: '🎂', names: ['birthday'] },
  { emoji: '🍕', names: ['pizza'] },
  { emoji: '🍻', names: ['beers'] },
  { emoji: '🍾', names: ['champagne'] },
  { emoji: '🏆', names: ['trophy'] },
  { emoji: '🎯', names: ['dart'] },
  { emoji: '🌞', names: ['sun_with_face'] },
  { emoji: '🌧️', names: ['cloud_with_rain'] },
  { emoji: '🌍', names: ['earth_africa'] },
  { emoji: '🐶', names: ['dog'] },
  { emoji: '🐱', names: ['cat'] },
  { emoji: '🙈', names: ['see_no_evil'] },
  { emoji: '💩', names: ['poop'] },
  { emoji: '🤖', names: ['robot'] },
  { emoji: '👻', names: ['ghost'] },
]

/** The palette's emoji: the first 32 of the table, four rows of eight. */
export const PALETTE_EMOJI: readonly EmojiShortcode[] = EMOJI.slice(0, 32)

/** How many emoji the list offers at once, as many as the member list. */
export const EMOJI_LIMIT = 6

const BY_NAME: ReadonlyMap<string, string> = new Map(
  EMOJI.flatMap(({ emoji, names }) => names.map((name) => [name, emoji] as const))
)

/** A shortcode's characters: lower-case letters, digits, `_`, `+` and `-`. */
const NAME = '[a-z0-9_+-]'

/**
 * The shortcode being typed at the caret: the « : » that starts it, at the start of the text or
 * after a space or an opening bracket, and at least two characters after it. Null otherwise, so
 * an address (« https: »), a time (« 12:30 ») or a lone « : » opens nothing.
 */
export function shortcodeAt(text: string, caret: number): { start: number; query: string } | null {
  const match = new RegExp(`(^|[\\s(])(:(${NAME}{2,32}))$`, 'u').exec(text.slice(0, caret))
  if (match === null) return null
  return { start: match.index + match[1]!.length, query: match[3]! }
}

/**
 * The emoji with a shortcode that starts with the query, then those with a later word of one
 * (after a `_`) that does; table order within each, at most `EMOJI_LIMIT`. Each emoji is
 * offered once, under the name that matched.
 */
export function matchingEmoji(query: string): { emoji: string; name: string }[] {
  const wanted = query.toLowerCase()
  const first: { emoji: string; name: string }[] = []
  const later: { emoji: string; name: string }[] = []
  for (const { emoji, names } of EMOJI) {
    const starts = names.find((name) => name.startsWith(wanted))
    if (starts !== undefined) {
      first.push({ emoji, name: starts })
      continue
    }
    const inner = names.find((name) =>
      name
        .split('_')
        .slice(1)
        .some((w) => w.startsWith(wanted))
    )
    if (inner !== undefined) later.push({ emoji, name: inner })
  }
  return [...first, ...later].slice(0, EMOJI_LIMIT)
}

/** The text with the typed shortcode replaced by the emoji and a space, and the caret after it. */
export function insertEmoji(
  text: string,
  shortcode: { start: number },
  caret: number,
  emoji: string
): { text: string; caret: number } {
  const inserted = `${emoji} `
  const after = text.slice(caret).replace(/^\s/u, '')
  return {
    text: `${text.slice(0, shortcode.start)}${inserted}${after}`,
    caret: shortcode.start + inserted.length,
  }
}

/**
 * What a code may not touch before it: a letter or a digit (« 10:100:20 », « a:wave:b »), a slash
 * (a path, as SharePoint's « /:x:/ » links), or a backslash, which is how a code is written as
 * text: a backslash then « :wave: » stays as typed, backslash and all.
 */
const GUARD_BEFORE = '(?<![\\p{L}\\p{N}/\\\\])'
/** What a code may not touch after it: a letter, a digit or a slash. */
const GUARD_AFTER = '(?![\\p{L}\\p{N}/])'

/** A known « :name: » standing alone. */
const CLOSED = new RegExp(`${GUARD_BEFORE}:(${NAME}{1,32}):${GUARD_AFTER}`, 'gu')

/**
 * Every known « :name: » in the text written as its emoji; unknown ones stay as typed, and so does
 * every web address, whatever it holds.
 */
export function replaceShortcodes(text: string): string {
  return linkSegments(text)
    .map((segment) =>
      'href' in segment
        ? segment.text
        : segment.text.replace(CLOSED, (whole, name: string) => BY_NAME.get(name) ?? whole)
    )
    .join('')
}

/**
 * The shortcode the last typed « : » closes, when it closes a known one ending at the caret: the
 * text with it written as the emoji, and the caret after it. Null otherwise. What follows the
 * caret is not looked at, so a code is converted as its « : » is typed.
 */
export function closeShortcode(
  text: string,
  caret: number
): { text: string; caret: number } | null {
  const before = text.slice(0, caret)
  // A web address being typed is left alone, as the send-time pass leaves it.
  if (/:\/\/\S*$/u.test(before)) return null
  const match = new RegExp(`${GUARD_BEFORE}:(${NAME}{1,32}):$`, 'u').exec(before)
  if (match === null) return null
  const emoji = BY_NAME.get(match[1]!)
  if (emoji === undefined) return null
  return {
    text: `${before.slice(0, match.index)}${emoji}${text.slice(caret)}`,
    caret: match.index + emoji.length,
  }
}

/** The text with the emoji written at the caret (or over the selection), and the caret after it. */
export function insertAtCaret(
  text: string,
  selection: { start: number; end: number },
  emoji: string
): { text: string; caret: number } {
  return {
    text: `${text.slice(0, selection.start)}${emoji}${text.slice(selection.end)}`,
    caret: selection.start + emoji.length,
  }
}
