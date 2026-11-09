import { describe, expect, it } from 'vitest'
import {
  EMOJI,
  EMOJI_LIMIT,
  PALETTE_EMOJI,
  closeShortcode,
  insertAtCaret,
  insertEmoji,
  matchingEmoji,
  replaceShortcodes,
  shortcodeAt,
} from './emoji'
import { QUICK_REACTIONS } from './ReactionPalette'

describe('the shortcode table', () => {
  it('gives each emoji and each code once, codes in the shortcode alphabet', () => {
    const emoji = EMOJI.map((entry) => entry.emoji)
    expect(new Set(emoji).size).toBe(emoji.length)
    const names = EMOJI.flatMap((entry) => entry.names)
    expect(new Set(names).size).toBe(names.length)
    for (const name of names) expect(name).toMatch(/^[a-z0-9_+-]{1,32}$/u)
  })

  it('opens the palette with the eight quick reactions, in their order, among 32', () => {
    expect(PALETTE_EMOJI).toHaveLength(32)
    expect(PALETTE_EMOJI.slice(0, 8).map((entry) => entry.emoji)).toEqual([...QUICK_REACTIONS])
  })
})

describe('shortcodeAt', () => {
  it('finds a « : » and two characters at the start, after a space or after « ( »', () => {
    expect(shortcodeAt(':wa', 3)).toEqual({ start: 0, query: 'wa' })
    expect(shortcodeAt('salut :wav', 10)).toEqual({ start: 6, query: 'wav' })
    expect(shortcodeAt('oui (:+1', 8)).toEqual({ start: 5, query: '+1' })
  })

  it('reads only up to the caret', () => {
    expect(shortcodeAt(':wave et la suite', 5)).toEqual({ start: 0, query: 'wave' })
  })

  it('opens nothing for one character, an address, a time or a word with a colon', () => {
    expect(shortcodeAt(':w', 2)).toBeNull()
    expect(shortcodeAt(':', 1)).toBeNull()
    expect(shortcodeAt('https://kodera.io', 8)).toBeNull()
    expect(shortcodeAt('à 12:30', 7)).toBeNull()
    expect(shortcodeAt('note:ab', 7)).toBeNull()
    expect(shortcodeAt(':wa ve', 6)).toBeNull()
    expect(shortcodeAt(':Wave', 5)).toBeNull()
  })
})

describe('matchingEmoji', () => {
  it('lists codes starting with the query first, then a later word of one', () => {
    expect(matchingEmoji('heart')[0]).toEqual({ emoji: '❤️', name: 'heart' })
    const check = matchingEmoji('check')
    expect(check).toContainEqual({ emoji: '✅', name: 'white_check_mark' })
    const smile = matchingEmoji('smil').map((match) => match.name)
    expect(smile.slice(0, 2)).toEqual(['smile', 'smiling_face_with_3_hearts'])
    expect(smile).toContain('slight_smile')
    expect(smile.indexOf('slight_smile')).toBeGreaterThan(
      smile.indexOf('smiling_face_with_3_hearts')
    )
  })

  it('offers an emoji once, under the code that matched, at most six', () => {
    expect(matchingEmoji('thumbs')).toEqual([
      { emoji: '👍', name: 'thumbsup' },
      { emoji: '👎', name: 'thumbsdown' },
    ])
    expect(matchingEmoji('s').length).toBe(EMOJI_LIMIT)
    expect(matchingEmoji('zzz')).toEqual([])
  })
})

describe('insertEmoji', () => {
  it('writes the emoji and a space over the typed code, keeping what follows', () => {
    expect(insertEmoji('salut :wa', { start: 6 }, 9, '👋')).toEqual({
      text: 'salut 👋 ',
      caret: 9,
    })
    expect(insertEmoji(':ta la suite', { start: 0 }, 3, '🎉')).toEqual({
      text: '🎉 la suite',
      caret: 3,
    })
  })
})

describe('replaceShortcodes', () => {
  it('writes every known code standing alone as its emoji', () => {
    expect(replaceShortcodes('Bravo :tada: :+1:')).toBe('Bravo 🎉 👍')
    expect(replaceShortcodes(':wave::smile:')).toBe('👋😄')
    expect(replaceShortcodes('(:100:)')).toBe('(💯)')
  })

  it('leaves an unknown code, a time, an address and a code touching a word', () => {
    const text = 'à 10:100:20, :inconnu:, https://x:wave:, a:wave:b et :Wave:'
    expect(replaceShortcodes(text)).toBe(text)
    // Only what follows the code counts here: a letter, a digit or a slash.
    expect(replaceShortcodes(':wave:bonjour :tada:2 :x:/chemin')).toBe(
      ':wave:bonjour :tada:2 :x:/chemin'
    )
  })

  it('never touches a web address, such as a SharePoint link holding « /:x:/ »', () => {
    const excel = 'https://contoso.sharepoint.com/:x:/g/personal/EaBc'
    const video = 'https://contoso.sharepoint.com/:v:/r/EaBc'
    expect(replaceShortcodes(`Le tableur ${excel} :tada:`)).toBe(`Le tableur ${excel} 🎉`)
    expect(replaceShortcodes(video)).toBe(video)
    // A code in a query or a fragment touches no slash: only reading the address as one keeps it.
    const search = 'https://exemple.fr/recherche?q=:tada:&page=:x:'
    expect(replaceShortcodes(`${search} :tada:`)).toBe(`${search} 🎉`)
    // Nor a path outside an address.
    expect(replaceShortcodes('dossier/:x:/fichier')).toBe('dossier/:x:/fichier')
  })

  it('leaves a code after a backslash as typed, backslash and all', () => {
    expect(replaceShortcodes('écrire \\:wave: donne :wave:')).toBe('écrire \\:wave: donne 👋')
  })
})

describe('closeShortcode', () => {
  it('writes a known code as its closing « : » is typed, caret after the emoji', () => {
    expect(closeShortcode('salut :wave:', 12)).toEqual({ text: 'salut 👋', caret: 8 })
    expect(closeShortcode(':x: après', 3)).toEqual({ text: '❌ après', caret: 1 })
  })

  it('does nothing for an unknown code, a code touching a word, or a caret elsewhere', () => {
    expect(closeShortcode(':inconnu:', 9)).toBeNull()
    expect(closeShortcode('12:30:', 6)).toBeNull()
    expect(closeShortcode('a:wave:', 7)).toBeNull()
    expect(closeShortcode(':wave: ', 7)).toBeNull()
  })

  it('does nothing inside a web address being typed, or after a backslash or a slash', () => {
    expect(closeShortcode('https://contoso.sharepoint.com/:x:', 34)).toBeNull()
    expect(closeShortcode('https://exemple.fr/?q=:tada:', 28)).toBeNull()
    // Once a space has ended the address, a code after it stands alone.
    expect(closeShortcode('voir https://a.fr/ :x:', 22)).toEqual({
      text: 'voir https://a.fr/ ❌',
      caret: 20,
    })
    expect(closeShortcode('\\:wave:', 7)).toBeNull()
    expect(closeShortcode('a/:x:', 5)).toBeNull()
  })
})

describe('insertAtCaret', () => {
  it('writes at the caret, or over the selection', () => {
    expect(insertAtCaret('ab', { start: 1, end: 1 }, '🔥')).toEqual({ text: 'a🔥b', caret: 3 })
    expect(insertAtCaret('abcd', { start: 1, end: 3 }, '🔥')).toEqual({ text: 'a🔥d', caret: 3 })
  })
})
