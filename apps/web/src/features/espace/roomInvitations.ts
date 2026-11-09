/** Matrix IDs accepted for invitations, including printable historical localparts. */
export function isMatrixUserId(value: string): boolean {
  return (
    value.length <= 255 &&
    /^@[\x21-\x39\x3b-\x7e]+:(?:[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?)*|\[[0-9A-Fa-f:.]+\])(?::[0-9]{1,5})?$/.test(
      value
    )
  )
}

/** Share real room identifiers; a missing canonical alias must never invent a join target. */
export function roomInvitationLinks({
  roomId,
  alias,
  serverName,
  channelSlug,
  org,
  channelId,
  origin,
}: {
  roomId: string
  alias: string | null
  serverName: string
  channelSlug: string
  org: string
  channelId: string
  origin: string
}) {
  const target = alias ?? roomId
  const via = encodeURIComponent(serverName)
  const path = encodeURIComponent(target.slice(1)).replaceAll('%3A', ':')
  return {
    matrixTo: `https://matrix.to/#/${encodeURIComponent(target)}?via=${via}`,
    matrixUri: `matrix:${alias === null ? 'roomid' : 'r'}/${path}?action=join&via=${via}`,
    alias: alias ?? `#${channelSlug}:${serverName}`,
    web: `${origin}/${encodeURIComponent(org)}/workspace/${encodeURIComponent(channelId)}`,
  }
}
