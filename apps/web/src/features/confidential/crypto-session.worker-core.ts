// Worker-internal primitives. Key material must never enter a document execution context.
if (typeof window !== 'undefined' || Reflect.has(globalThis, 'document'))
  throw new Error('Worker crypto only.')

export class ConfidentialCryptoError extends Error {
  constructor() {
    super('Confidential crypto refused.')
    this.name = 'ConfidentialCryptoError'
  }
}
export function need(value: unknown): asserts value {
  if (!value) throw new ConfidentialCryptoError()
}
export function fields(input: unknown, keys: readonly string[]): Record<string, unknown> {
  need(
    input !== null && typeof input === 'object' && Object.getPrototypeOf(input) === Object.prototype
  )
  const descriptors = Object.getOwnPropertyDescriptors(input)
  need(Reflect.ownKeys(descriptors).length === keys.length)
  const output: Record<string, unknown> = Object.create(null) as Record<string, unknown>
  for (const key of keys) {
    const descriptor = descriptors[key]
    need(descriptor && 'value' in descriptor && descriptor.enumerable)
    output[key] = descriptor.value
  }
  return output
}
const typed = Object.getPrototypeOf(Uint8Array.prototype) as object
const bufferOf = Object.getOwnPropertyDescriptor(typed, 'buffer')!.get!
const lengthOf = Object.getOwnPropertyDescriptor(typed, 'byteLength')!.get!
const offsetOf = Object.getOwnPropertyDescriptor(typed, 'byteOffset')!.get!
const resizable = Object.getOwnPropertyDescriptor(ArrayBuffer.prototype, 'resizable')?.get
export function ownedBytes(value: unknown, min = 1, max = 1024 * 1024): Uint8Array<ArrayBuffer> {
  need(
    value instanceof Uint8Array &&
      Object.getPrototypeOf(value) === Uint8Array.prototype &&
      Reflect.ownKeys(value).every(
        (key) => typeof key === 'string' && /^(0|[1-9][0-9]*)$/.test(key)
      )
  )
  const buffer: unknown = Reflect.apply(bufferOf, value, [])
  const length: number = Reflect.apply(lengthOf, value, [])
  const offset: number = Reflect.apply(offsetOf, value, [])
  need(
    buffer instanceof ArrayBuffer &&
      (!resizable || Reflect.apply(resizable, buffer, []) === false) &&
      length >= min &&
      length <= max
  )
  return new Uint8Array(new Uint8Array(buffer, offset, length))
}
export function text(value: unknown): asserts value is string {
  need(
    typeof value === 'string' &&
      value.length > 0 &&
      value.length <= 256 &&
      Array.from(value).every((character) => {
        const point = character.codePointAt(0)!
        return point >= 32 && (point < 0xd800 || point > 0xdfff)
      })
  )
}
export function integer(value: unknown): asserts value is number {
  need(
    typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 && value <= 0xffffffff
  )
}
const encoder = new TextEncoder(),
  decoder = new TextDecoder('utf-8', { fatal: true })
export type CryptoScope = readonly (string | number)[]
export interface FrameMetadata {
  epoch: number
  sender: string
  sequence: number
  kind: string | number
  ratchet: number
}
export class WorkerFrameCryptor {
  #secret: Uint8Array<ArrayBuffer>
  #active = true
  #queue = Promise.resolve()
  #sequence = 0
  #ratchet = 0
  #epoch: number
  #received = new Map<string, { highest: number; seen: Set<number> }>()
  constructor(
    readonly magic: string,
    readonly domain: string,
    readonly scope: CryptoScope,
    epoch: number,
    readonly sender: string,
    secret: Uint8Array
  ) {
    integer(epoch)
    text(sender)
    need(magic.length === 4)
    this.#epoch = epoch
    this.#secret = ownedBytes(secret, 32, 32)
  }
  get epoch(): number {
    return this.#epoch
  }
  isActive(): boolean {
    return this.#active
  }
  close(): void {
    this.#active = false
    this.#secret.fill(0)
    this.#received.clear()
  }
  #current(epoch: number, ratchet: number): void {
    need(this.#active && epoch === this.#epoch && ratchet === this.#ratchet)
  }
  #run<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.#queue.then(operation)
    this.#queue = result.then(
      () => undefined,
      () => undefined
    )
    return result
  }
  async #key(
    epoch: number,
    ratchet: number,
    sender: string,
    kind: string | number
  ): Promise<CryptoKey> {
    const secret = new Uint8Array(this.#secret)
    try {
      const material = await crypto.subtle.importKey('raw', secret, 'HKDF', false, ['deriveKey'])
      this.#current(epoch, ratchet)
      const key = await crypto.subtle.deriveKey(
        {
          name: 'HKDF',
          hash: 'SHA-256',
          salt: encoder.encode(this.domain),
          info: encoder.encode(
            JSON.stringify([this.domain, 1, ...this.scope, epoch, ratchet, sender, kind])
          ),
        },
        material,
        { name: 'AES-GCM', length: 256 },
        false,
        ['encrypt', 'decrypt']
      )
      this.#current(epoch, ratchet)
      return key
    } finally {
      secret.fill(0)
    }
  }
  #aad(meta: FrameMetadata): Uint8Array<ArrayBuffer> {
    // Collaboration scope is [scopeKey, documentId]; all wire metadata is authenticated.
    return encoder.encode(
      JSON.stringify([
        this.domain,
        1,
        ...this.scope,
        meta.epoch,
        meta.kind,
        meta.sender,
        meta.sequence,
        meta.ratchet,
      ])
    )
  }
  seal(input: Uint8Array, kind: string | number): Promise<Uint8Array<ArrayBuffer>> {
    const plaintext = ownedBytes(input)
    const epoch = this.#epoch,
      ratchet = this.#ratchet
    return this.#run(async () => {
      try {
        this.#current(epoch, ratchet)
        need(this.#sequence < Number.MAX_SAFE_INTEGER)
        const meta = { epoch, sender: this.sender, sequence: ++this.#sequence, kind, ratchet }
        const metadata = encoder.encode(JSON.stringify(meta)),
          iv = crypto.getRandomValues(new Uint8Array(12))
        const key = await this.#key(epoch, ratchet, this.sender, kind)
        const ciphertext = new Uint8Array(
          await crypto.subtle.encrypt(
            { name: 'AES-GCM', iv, additionalData: this.#aad(meta), tagLength: 128 },
            key,
            plaintext
          )
        )
        this.#current(epoch, ratchet)
        const output = new Uint8Array(6 + metadata.length + 12 + ciphertext.length)
        output.set(encoder.encode(this.magic))
        new DataView(output.buffer).setUint16(4, metadata.length)
        output.set(metadata, 6)
        output.set(iv, 6 + metadata.length)
        output.set(ciphertext, 18 + metadata.length)
        return output
      } finally {
        plaintext.fill(0)
      }
    })
  }
  open(
    input: Uint8Array,
    allowed: (kind: unknown) => boolean,
    expectedSender?: string
  ): Promise<Uint8Array<ArrayBuffer>> {
    const envelope = ownedBytes(input, 35, 1024 * 1024 + 2048)
    const epoch = this.#epoch,
      ratchet = this.#ratchet
    return this.#run(async () => {
      let plaintext: Uint8Array<ArrayBuffer> | undefined
      try {
        this.#current(epoch, ratchet)
        need(decoder.decode(envelope.subarray(0, 4)) === this.magic)
        const size = new DataView(envelope.buffer).getUint16(4)
        need(size > 0 && size <= 1024 && envelope.length > 6 + size + 28)
        const encoded = decoder.decode(envelope.subarray(6, 6 + size))
        const raw = fields(JSON.parse(encoded) as unknown, [
          'epoch',
          'sender',
          'sequence',
          'kind',
          'ratchet',
        ])
        integer(raw.epoch)
        integer(raw.ratchet)
        text(raw.sender)
        need(
          typeof raw.sequence === 'number' &&
            Number.isSafeInteger(raw.sequence) &&
            raw.sequence > 0 &&
            allowed(raw.kind)
        )
        const meta: FrameMetadata = {
          epoch: raw.epoch,
          sender: raw.sender,
          sequence: raw.sequence,
          kind: raw.kind as string | number,
          ratchet: raw.ratchet,
        }
        need(
          JSON.stringify(meta) === encoded &&
            meta.epoch === epoch &&
            meta.ratchet === ratchet &&
            (expectedSender === undefined || meta.sender === expectedSender)
        )
        const senderKey = JSON.stringify(
          this.domain === 'kodera-confidential-collab' ? [meta.sender] : [meta.sender, meta.kind]
        )
        const received = this.#received.get(senderKey),
          reorderable = this.domain === 'kodera-confidential-media'
        need(
          (received === undefined ||
            (reorderable
              ? meta.sequence > received.highest - 1024 && !received.seen.has(meta.sequence)
              : meta.sequence > received.highest)) &&
            (received !== undefined || this.#received.size < 4096)
        )
        const key = await this.#key(epoch, ratchet, meta.sender, meta.kind)
        plaintext = new Uint8Array(
          await crypto.subtle.decrypt(
            {
              name: 'AES-GCM',
              iv: envelope.subarray(6 + size, 18 + size),
              additionalData: this.#aad(meta),
              tagLength: 128,
            },
            key,
            envelope.subarray(18 + size)
          )
        )
        this.#current(epoch, ratchet)
        const highest = Math.max(received?.highest ?? 0, meta.sequence),
          seen = received?.seen ?? new Set<number>()
        if (reorderable) {
          seen.add(meta.sequence)
          for (const sequence of seen) if (sequence <= highest - 1024) seen.delete(sequence)
        }
        this.#received.set(senderKey, { highest, seen })
        const output = plaintext
        plaintext = undefined
        return output
      } finally {
        envelope.fill(0)
        plaintext?.fill(0)
      }
    })
  }
  ratchetEpochKey(nextEpoch: number): Promise<void> {
    integer(nextEpoch)
    return this.#run(async () => {
      need(this.#active && nextEpoch > this.#epoch)
      const epoch = this.#epoch,
        ratchet = this.#ratchet,
        old = new Uint8Array(this.#secret)
      let next: Uint8Array<ArrayBuffer> | undefined
      try {
        const material = await crypto.subtle.importKey('raw', old, 'HKDF', false, ['deriveBits'])
        next = new Uint8Array(
          await crypto.subtle.deriveBits(
            {
              name: 'HKDF',
              hash: 'SHA-256',
              salt: encoder.encode('kodera-confidential-media-ratchet'),
              info: encoder.encode(JSON.stringify([...this.scope, epoch, nextEpoch, ratchet + 1])),
            },
            material,
            256
          )
        )
        this.#current(epoch, ratchet)
        this.#secret.fill(0)
        this.#secret = next
        next = undefined
        this.#epoch = nextEpoch
        this.#ratchet++
        this.#sequence = 0
        this.#received.clear()
      } finally {
        old.fill(0)
        next?.fill(0)
      }
    })
  }
}
