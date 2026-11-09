// The two rules of docs/specs/domain-addresses-list.md, "One module for what
// depends on how an instance is hosted", as functions over source text so the
// test beside this file can feed them a planted violation as easily as the
// real tree.
//
// Both are text searches, on purpose: they judge comments and strings too. A
// host name of ours in a comment is one copy-paste away from being in code,
// and the point of the rule is that the area's files do not know it at all.

import { isIP } from 'node:net'

export interface SourceFile {
  /** Repository-relative, with forward slashes. */
  path: string
  text: string
}

interface LiteralRule {
  rule: string
  pattern: RegExp
  /** Remove surrounding punctuation before judging the candidate. */
  normalize?: (found: string) => string
  /** Reject lexical candidates that are not actually IP addresses. */
  valid?: (found: string) => boolean
  /** A match the rule lets through, with the reason written beside it. */
  allowed?: (found: string) => boolean
}

// Documentation ranges (RFC 5737, RFC 3849): addresses that can never be
// anybody's, which is why the contract's own examples use them.
const DOCUMENTATION_V4 = /^(?:192\.0\.2|198\.51\.100|203\.0\.113)\.\d{1,3}$/
const DOCUMENTATION_V6 = /^2001:db8:/i

const LITERAL_RULES: readonly LiteralRule[] = [
  {
    rule: 'an IP address',
    pattern: /\b(?:\d{1,3}\.){3}\d{1,3}\b/g,
    allowed: (found) => DOCUMENTATION_V4.test(found),
  },
  {
    rule: 'an IP address',
    // Parse the complete colon-containing token, including leading compression and
    // embedded IPv4, rather than trying to recognise IPv6 with a partial regex.
    pattern: /(?<![0-9a-z_:.])[0-9a-f:.]*:[0-9a-f:.]*(?![0-9a-z_:.])/gi,
    // A comment sentence may end directly after the address. Internal dots in
    // an embedded IPv4 address remain part of the candidate.
    normalize: (found) => found.replace(/\.+$/, ''),
    valid: (found) => isIP(found) === 6,
    allowed: (found) => DOCUMENTATION_V6.test(found),
  },
  // Any name under either brand, whatever it ends in: the list of our zones is
  // exactly what these files must not carry.
  { rule: 'a host name of ours', pattern: /\b(?:samourai|kodera)\.[a-z]{2,}\b/gi },
  {
    rule: 'the name of a hosting provider',
    pattern:
      /\b(?:scaleway|ovh(?:cloud)?|hetzner|outscale|ionos|infomaniak|exoscale|clever[ -]cloud|gandi|cloudflare|digitalocean|aws|amazon|azure|gcp|google cloud)\b/gi,
  },
  // Nouns of place, not the adjectives that also name a language: a comment
  // may say a test asserts on the rendered French.
  {
    rule: 'a place',
    pattern:
      /\b(?:france|paris|fr-par|europe|germany|allemagne|finland|finlande|netherlands|pays-bas|poland|pologne)\b/gi,
  },
]

// The contract fields, and the values of them, that describe DNS records and
// how an instance is hosted. `role` is read through `isAddressPurpose` and is
// not listed: the word is a membership's too.
const HOSTING_FIELDS: readonly RegExp[] = [
  /\bdefault_urls\b/g,
  /\brecord_(?:type|name|value)\b/g,
  /\bobserved_value\b/g,
  /\bttl_s\b/g,
  /(['"`])(?:apex|subdomain|CNAME|TXT|media|web_target|media_target)\1/g,
]

function lineOf(text: string, index: number): number {
  return text.slice(0, index).split('\n').length
}

/** Every IP address, host name of ours, provider or place written in `files`. */
export function literalLeaks(files: readonly SourceFile[]): string[] {
  const leaks: string[] = []
  for (const file of files) {
    for (const { rule, pattern, normalize, valid, allowed } of LITERAL_RULES) {
      for (const match of file.text.matchAll(pattern)) {
        const found = normalize?.(match[0]) ?? match[0]
        if (valid?.(found) === false || allowed?.(found) === true) continue
        leaks.push(`${file.path}:${String(lineOf(file.text, match.index))}: ${rule} (${found})`)
      }
    }
  }
  return leaks
}

/** The hosting fields `file` names, in the order they appear. */
export function hostingFieldsNamedIn(file: SourceFile): string[] {
  return HOSTING_FIELDS.flatMap((pattern) => [...file.text.matchAll(pattern)])
    .sort((a, b) => a.index - b.index)
    .map((match) => `${file.path}:${String(lineOf(file.text, match.index))}: ${match[0]}`)
}

/** The one module the hosting fields may be named in. */
export const HOSTING_MODULE = 'src/features/domain/hosting.ts'

/**
 * Every hosting field named in the area's own code outside the one module.
 * Tests are not judged by this rule: they build what the API would send.
 */
export function fieldLeaks(files: readonly SourceFile[]): string[] {
  return files
    .filter((file) => file.path.startsWith('src/features/domain/'))
    .filter((file) => file.path !== HOSTING_MODULE && !/\.test\.tsx?$/.test(file.path))
    .flatMap(hostingFieldsNamedIn)
}
