/** Room metadata describes transport policy; it never proves successful decryption. */
export const CONFIDENTIAL_MARKER = 'io.kodera.room.confidential'
export const ROOM_ENCRYPTION = 'm.room.encryption'
export type RoomAlgorithm = 'io.kodera.mls.v1' | 'm.megolm.v1.aes-sha2'
export type RoomBoundary =
  'unknown' | 'ordinary' | 'community' | 'confidential-unavailable' | 'invalid'
export interface RoomStateValue {
  readonly sender: string | undefined
  readonly content: unknown
}
const record = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value)

/** Sticky per-session classification prevents removal of a marker from enabling plaintext. */
export class RoomBoundaryTracker {
  readonly #protected = new Set<string>()

  observe(
    roomId: string,
    creation: RoomStateValue | undefined,
    encryption: RoomStateValue | undefined,
    trustedCreator: string,
    publicCommunity = false
  ): RoomBoundary {
    const content = creation?.content
    const markerPresent = record(content) && Object.hasOwn(content, CONFIDENTIAL_MARKER)
    const encrypted = encryption !== undefined
    if (markerPresent || encrypted) this.#protected.add(roomId)
    if (!record(content)) return this.#protected.has(roomId) ? 'invalid' : 'unknown'
    if (!markerPresent) {
      if (this.#protected.has(roomId)) return 'invalid'
      return publicCommunity ? 'community' : 'ordinary'
    }
    const algorithm = content[CONFIDENTIAL_MARKER]
    const initial = encryption?.content
    if (
      (algorithm !== 'io.kodera.mls.v1' && algorithm !== 'm.megolm.v1.aes-sha2') ||
      creation?.sender !== trustedCreator ||
      encryption?.sender !== trustedCreator ||
      !record(initial) ||
      Object.keys(initial).length !== 1 ||
      initial.algorithm !== algorithm
    )
      return 'invalid'
    // A syntactically valid state is insufficient: the shipped native facade has no room actor.
    return 'confidential-unavailable'
  }
}

export function permitsPlaintext(boundary: RoomBoundary): boolean {
  return boundary === 'ordinary' || boundary === 'community'
}

export class ConfidentialRoomUnavailable extends Error {
  constructor() {
    super('The room has no verified encryption session. No content was sent.')
    this.name = 'ConfidentialRoomUnavailable'
  }
}
