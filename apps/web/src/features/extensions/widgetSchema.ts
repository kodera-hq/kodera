import { validateExtensionWebhookUrl } from './catalog'

export const WIDGET_SCHEMA_VERSION = 'kodera.widget.v1' as const
export const MAX_WIDGET_CARD_BYTES = 16_384
export const MAX_WIDGET_AST_DEPTH = 4
export const MAX_WIDGET_BLOCKS = 20
export const MAX_WIDGET_KV_ITEMS = 12
export const MAX_WIDGET_BUTTON_ACTIONS = 5

export type WidgetTextTone = 'default' | 'muted' | 'mono'
export type WidgetStatusState = 'success' | 'info' | 'warning' | 'danger' | 'neutral' | 'planned'
export type WidgetProgressTone = 'default' | 'warning' | 'danger' | 'success'
export type WidgetButtonVariant = 'primary' | 'secondary' | 'tertiary' | 'destructive'
export type WidgetLinkVariant = 'secondary' | 'tertiary'

export interface WidgetHeaderBlock {
  readonly type: 'header'
  readonly title: string
  readonly subtitle?: string | undefined
}

export interface WidgetTextBlock {
  readonly type: 'text'
  readonly body: string
  readonly tone?: WidgetTextTone | undefined
}

export interface WidgetKvItem {
  readonly label: string
  readonly value: string
  readonly mono?: boolean | undefined
}

export interface WidgetKvListBlock {
  readonly type: 'kv_list'
  readonly items: readonly WidgetKvItem[]
}

export interface WidgetStatusPillBlock {
  readonly type: 'status_pill'
  readonly label: string
  readonly state: WidgetStatusState
}

export interface WidgetProgressBarBlock {
  readonly type: 'progress_bar'
  readonly label: string
  readonly value: number
  readonly valueText?: string | undefined
  readonly tone?: WidgetProgressTone | undefined
}

export interface WidgetActionButton {
  readonly actionId: string
  readonly label: string
  readonly variant?: WidgetButtonVariant | undefined
  readonly value?: string | undefined
}

export interface WidgetButtonRowBlock {
  readonly type: 'button_row'
  readonly actions: readonly WidgetActionButton[]
}

export interface WidgetLinkButtonBlock {
  readonly type: 'link_button'
  readonly label: string
  readonly href: string
  readonly variant?: WidgetLinkVariant | undefined
}

export type WidgetBlock =
  | WidgetHeaderBlock
  | WidgetTextBlock
  | WidgetKvListBlock
  | WidgetStatusPillBlock
  | WidgetProgressBarBlock
  | WidgetButtonRowBlock
  | WidgetLinkButtonBlock

export interface WidgetCard {
  readonly schemaVersion: typeof WIDGET_SCHEMA_VERSION
  readonly widgetId: string
  readonly title?: string | undefined
  readonly blocks: readonly WidgetBlock[]
}

export type WidgetValidationErrorCode =
  | 'INVALID_WIDGET_OBJECT'
  | 'WIDGET_PROTOTYPE_POLLUTION'
  | 'WIDGET_DEPTH_EXCEEDED'
  | 'WIDGET_TOO_LARGE'
  | 'WIDGET_UNKNOWN_FIELD'
  | 'INVALID_WIDGET_SCHEMA'
  | 'INVALID_WIDGET_ID'
  | 'INVALID_WIDGET_BLOCKS'
  | 'INVALID_WIDGET_BLOCK'
  | 'WIDGET_TOO_MANY_ACTIONS'
  | 'INVALID_WIDGET_ACTION'
  | 'INVALID_WIDGET_PROGRESS'
  | 'INVALID_WIDGET_LINK'

export type WidgetValidationResult =
  | { readonly ok: true; readonly card: WidgetCard }
  | { readonly ok: false; readonly code: WidgetValidationErrorCode }

const FORBIDDEN_KEYS = new Set(['__proto__', 'constructor', 'prototype'])
const SLUG_RE = /^[a-z0-9][a-z0-9-]{0,61}[a-z0-9]$/
const ACTION_ID_RE = /^[a-z0-9][a-z0-9_-]{0,63}$/
const STATUS_STATES: ReadonlySet<string> = new Set([
  'success',
  'info',
  'warning',
  'danger',
  'neutral',
  'planned',
])
const TEXT_TONES: ReadonlySet<string> = new Set(['default', 'muted', 'mono'])
const PROGRESS_TONES: ReadonlySet<string> = new Set(['default', 'warning', 'danger', 'success'])
const BUTTON_VARIANTS: ReadonlySet<string> = new Set([
  'primary',
  'secondary',
  'tertiary',
  'destructive',
])
const LINK_VARIANTS: ReadonlySet<string> = new Set(['secondary', 'tertiary'])

class WidgetValidationFailure extends Error {
  readonly code: WidgetValidationErrorCode
  constructor(code: WidgetValidationErrorCode) {
    super(code)
    this.code = code
  }
}

function assertNoForbiddenKeys(target: object): void {
  if (Object.getOwnPropertySymbols(target).length > 0) {
    throw new WidgetValidationFailure('WIDGET_PROTOTYPE_POLLUTION')
  }
  for (const key of Object.getOwnPropertyNames(target)) {
    if (FORBIDDEN_KEYS.has(key)) {
      throw new WidgetValidationFailure('WIDGET_PROTOTYPE_POLLUTION')
    }
  }
}

function assertSafeTree(node: unknown, depth = 0): void {
  if (node === null || typeof node !== 'object') {
    if (
      node === undefined ||
      typeof node === 'string' ||
      typeof node === 'boolean' ||
      (typeof node === 'number' && Number.isFinite(node))
    ) {
      return
    }
    throw new WidgetValidationFailure('INVALID_WIDGET_OBJECT')
  }
  if (depth > MAX_WIDGET_AST_DEPTH) {
    throw new WidgetValidationFailure('WIDGET_DEPTH_EXCEEDED')
  }
  if (Array.isArray(node)) {
    assertNoForbiddenKeys(node)
    for (let idx = 0; idx < node.length; idx += 1) {
      if (!Object.prototype.hasOwnProperty.call(node, idx)) {
        throw new WidgetValidationFailure('INVALID_WIDGET_OBJECT')
      }
      assertSafeTree(node[idx], depth + 1)
    }
    return
  }
  const proto = Object.getPrototypeOf(node)
  if (proto !== Object.prototype && proto !== null) {
    throw new WidgetValidationFailure('WIDGET_PROTOTYPE_POLLUTION')
  }
  assertNoForbiddenKeys(node)
  for (const key of Object.getOwnPropertyNames(node)) {
    const desc = Object.getOwnPropertyDescriptor(node, key)
    if (!desc || !desc.enumerable || !('value' in desc)) {
      throw new WidgetValidationFailure('WIDGET_PROTOTYPE_POLLUTION')
    }
    assertSafeTree(desc.value, depth + 1)
  }
}

function assertClosedKeys(obj: Record<string, unknown>, allowed: readonly string[]): void {
  const allowedSet = new Set(allowed)
  for (const key of Object.getOwnPropertyNames(obj)) {
    if (!allowedSet.has(key)) {
      throw new WidgetValidationFailure('WIDGET_UNKNOWN_FIELD')
    }
  }
}

function readPrintableText(
  raw: unknown,
  maxLength: number,
  code: WidgetValidationErrorCode = 'INVALID_WIDGET_BLOCK'
): string {
  if (typeof raw !== 'string') {
    throw new WidgetValidationFailure(code)
  }
  for (let i = 0; i < raw.length; i += 1) {
    const ch = raw.charCodeAt(i)
    if ((ch >= 0 && ch <= 8) || ch === 11 || ch === 12 || (ch >= 14 && ch <= 31) || ch === 127) {
      throw new WidgetValidationFailure(code)
    }
  }
  const trimmed = raw.trim()
  if (trimmed.length === 0 || trimmed.length > maxLength) {
    throw new WidgetValidationFailure(code)
  }
  return trimmed
}

function parseBlock(rawBlock: unknown): WidgetBlock {
  if (!rawBlock || typeof rawBlock !== 'object' || Array.isArray(rawBlock)) {
    throw new WidgetValidationFailure('INVALID_WIDGET_BLOCK')
  }
  const block = rawBlock as Record<string, unknown>
  switch (block.type) {
    case 'header': {
      assertClosedKeys(block, ['type', 'title', 'subtitle'])
      const title = readPrintableText(block.title, 160)
      const subtitle =
        block.subtitle !== undefined ? readPrintableText(block.subtitle, 240) : undefined
      return subtitle !== undefined ? { type: 'header', title, subtitle } : { type: 'header', title }
    }
    case 'text': {
      assertClosedKeys(block, ['type', 'body', 'tone'])
      const body = readPrintableText(block.body, 2000)
      const rawTone = block.tone ?? 'default'
      if (typeof rawTone !== 'string' || !TEXT_TONES.has(rawTone)) {
        throw new WidgetValidationFailure('INVALID_WIDGET_BLOCK')
      }
      return { type: 'text', body, tone: rawTone as WidgetTextTone }
    }
    case 'kv_list': {
      assertClosedKeys(block, ['type', 'items'])
      if (
        !Array.isArray(block.items) ||
        block.items.length === 0 ||
        block.items.length > MAX_WIDGET_KV_ITEMS
      ) {
        throw new WidgetValidationFailure('INVALID_WIDGET_BLOCK')
      }
      const items: WidgetKvItem[] = block.items.map((rawItem) => {
        if (!rawItem || typeof rawItem !== 'object' || Array.isArray(rawItem)) {
          throw new WidgetValidationFailure('INVALID_WIDGET_BLOCK')
        }
        const entry = rawItem as Record<string, unknown>
        assertClosedKeys(entry, ['label', 'value', 'mono'])
        if (entry.mono !== undefined && typeof entry.mono !== 'boolean') {
          throw new WidgetValidationFailure('INVALID_WIDGET_BLOCK')
        }
        const label = readPrintableText(entry.label, 80)
        const value = readPrintableText(entry.value, 240)
        return entry.mono !== undefined ? { label, value, mono: entry.mono } : { label, value }
      })
      return { type: 'kv_list', items }
    }
    case 'status_pill': {
      assertClosedKeys(block, ['type', 'label', 'state'])
      const label = readPrintableText(block.label, 80)
      if (typeof block.state !== 'string' || !STATUS_STATES.has(block.state)) {
        throw new WidgetValidationFailure('INVALID_WIDGET_BLOCK')
      }
      return { type: 'status_pill', label, state: block.state as WidgetStatusState }
    }
    case 'progress_bar': {
      assertClosedKeys(block, ['type', 'label', 'value', 'valueText', 'tone'])
      const label = readPrintableText(block.label, 120)
      if (
        typeof block.value !== 'number' ||
        !Number.isFinite(block.value) ||
        block.value < 0 ||
        block.value > 100
      ) {
        throw new WidgetValidationFailure('INVALID_WIDGET_PROGRESS')
      }
      const rawTone = block.tone ?? 'default'
      if (typeof rawTone !== 'string' || !PROGRESS_TONES.has(rawTone)) {
        throw new WidgetValidationFailure('INVALID_WIDGET_BLOCK')
      }
      const valueText =
        block.valueText !== undefined ? readPrintableText(block.valueText, 40) : undefined
      const normalizedValue = block.value === 0 ? 0 : block.value
      return {
        type: 'progress_bar',
        label,
        value: normalizedValue,
        tone: rawTone as WidgetProgressTone,
        ...(valueText !== undefined ? { valueText } : {}),
      }
    }
    case 'button_row': {
      assertClosedKeys(block, ['type', 'actions'])
      if (!Array.isArray(block.actions) || block.actions.length === 0) {
        throw new WidgetValidationFailure('INVALID_WIDGET_BLOCK')
      }
      if (block.actions.length > MAX_WIDGET_BUTTON_ACTIONS) {
        throw new WidgetValidationFailure('WIDGET_TOO_MANY_ACTIONS')
      }
      const seenIds = new Set<string>()
      const actions: WidgetActionButton[] = block.actions.map((rawAction) => {
        if (!rawAction || typeof rawAction !== 'object' || Array.isArray(rawAction)) {
          throw new WidgetValidationFailure('INVALID_WIDGET_ACTION')
        }
        const act = rawAction as Record<string, unknown>
        assertClosedKeys(act, ['actionId', 'label', 'variant', 'value'])
        if (
          typeof act.actionId !== 'string' ||
          !ACTION_ID_RE.test(act.actionId) ||
          seenIds.has(act.actionId)
        ) {
          throw new WidgetValidationFailure('INVALID_WIDGET_ACTION')
        }
        seenIds.add(act.actionId)
        const label = readPrintableText(act.label, 64, 'INVALID_WIDGET_ACTION')
        const rawVariant = act.variant ?? 'secondary'
        if (typeof rawVariant !== 'string' || !BUTTON_VARIANTS.has(rawVariant)) {
          throw new WidgetValidationFailure('INVALID_WIDGET_ACTION')
        }
        if (act.value !== undefined) {
          if (typeof act.value !== 'string' || act.value.length > 256) {
            throw new WidgetValidationFailure('INVALID_WIDGET_ACTION')
          }
          for (let i = 0; i < act.value.length; i += 1) {
            const ch = act.value.charCodeAt(i)
            if (ch < 32 || ch === 127) {
              throw new WidgetValidationFailure('INVALID_WIDGET_ACTION')
            }
          }
        }
        return {
          actionId: act.actionId,
          label,
          variant: rawVariant as WidgetButtonVariant,
          ...(act.value !== undefined ? { value: act.value } : {}),
        }
      })
      return { type: 'button_row', actions }
    }
    case 'link_button': {
      assertClosedKeys(block, ['type', 'label', 'href', 'variant'])
      const label = readPrintableText(block.label, 80, 'INVALID_WIDGET_LINK')
      if (typeof block.href !== 'string') {
        throw new WidgetValidationFailure('INVALID_WIDGET_LINK')
      }
      const validated = validateExtensionWebhookUrl(block.href)
      if (!validated.ok) {
        throw new WidgetValidationFailure('INVALID_WIDGET_LINK')
      }
      const rawVariant = block.variant ?? 'secondary'
      if (typeof rawVariant !== 'string' || !LINK_VARIANTS.has(rawVariant)) {
        throw new WidgetValidationFailure('INVALID_WIDGET_LINK')
      }
      return {
        type: 'link_button',
        label,
        href: validated.normalizedUrl,
        variant: rawVariant as WidgetLinkVariant,
      }
    }
    default:
      throw new WidgetValidationFailure('INVALID_WIDGET_BLOCK')
  }
}

export function validateWidgetCard(input: unknown): WidgetValidationResult {
  try {
    if (!input || typeof input !== 'object' || Array.isArray(input)) {
      throw new WidgetValidationFailure('INVALID_WIDGET_OBJECT')
    }
    assertSafeTree(input, 0)

    let encodedBytes: Uint8Array
    try {
      encodedBytes = new TextEncoder().encode(JSON.stringify(input))
    } catch {
      throw new WidgetValidationFailure('INVALID_WIDGET_OBJECT')
    }
    if (encodedBytes.byteLength > MAX_WIDGET_CARD_BYTES) {
      throw new WidgetValidationFailure('WIDGET_TOO_LARGE')
    }

    const root = input as Record<string, unknown>
    assertClosedKeys(root, ['schemaVersion', 'widgetId', 'title', 'blocks'])
    if (root.schemaVersion !== WIDGET_SCHEMA_VERSION) {
      throw new WidgetValidationFailure('INVALID_WIDGET_SCHEMA')
    }
    if (
      typeof root.widgetId !== 'string' ||
      !SLUG_RE.test(root.widgetId) ||
      root.widgetId.includes('--')
    ) {
      throw new WidgetValidationFailure('INVALID_WIDGET_ID')
    }
    if (
      !Array.isArray(root.blocks) ||
      root.blocks.length === 0 ||
      root.blocks.length > MAX_WIDGET_BLOCKS
    ) {
      throw new WidgetValidationFailure('INVALID_WIDGET_BLOCKS')
    }

    const title = root.title !== undefined ? readPrintableText(root.title, 120) : undefined
    const blocks = root.blocks.map((b) => parseBlock(b))
    const card: WidgetCard = {
      schemaVersion: WIDGET_SCHEMA_VERSION,
      widgetId: root.widgetId,
      ...(title !== undefined ? { title } : {}),
      blocks,
    }
    if (new TextEncoder().encode(JSON.stringify(card)).byteLength > MAX_WIDGET_CARD_BYTES) {
      throw new WidgetValidationFailure('WIDGET_TOO_LARGE')
    }
    return { ok: true, card }
  } catch (err) {
    if (err instanceof WidgetValidationFailure) {
      return { ok: false, code: err.code }
    }
    return { ok: false, code: 'INVALID_WIDGET_OBJECT' }
  }
}
