// The welcome channel's arrivals as timeline inserts: one `ArrivalCard` per newcomer, at the time
// they joined. Waving sends the 👋 reaction on their join event; the card remembers it was waved.

import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { formatTime } from '../../i18n/format'
import { ArrivalCard, WAVE } from './ArrivalCard'
import type { TimelineInsert } from './liveViewModel'
import type { ArrivalView } from './matrix/store'
import { MemberAvatar } from './MemberAvatar'

function Arrival({
  arrival,
  name,
  canReact,
  onWave,
}: {
  arrival: ArrivalView
  name: string
  canReact: boolean
  onWave: (eventId: string) => Promise<void>
}) {
  const { i18n } = useTranslation()
  const [waved, setWaved] = useState(false)
  const iso = new Date(arrival.ts).toISOString()
  return (
    <ArrivalCard
      name={name}
      userId={arrival.userId}
      avatar={
        <MemberAvatar mxc={arrival.avatarMxc} name={name} identity={arrival.userId} size="lg" />
      }
      dateTime={iso}
      timeLabel={formatTime(iso, i18n.resolvedLanguage === 'en' ? 'en' : 'fr')}
      waved={waved}
      disabled={!canReact}
      onWave={() => {
        setWaved(true)
        onWave(arrival.eventId).catch(() => setWaved(false))
      }}
    />
  )
}

export function arrivalInserts(
  arrivals: readonly ArrivalView[],
  nameOf: (arrival: ArrivalView) => string,
  canReact: boolean,
  wave: (eventId: string, emoji: string) => Promise<void>
): TimelineInsert[] {
  return arrivals.map((arrival) => ({
    key: `arrival:${arrival.eventId}`,
    ts: arrival.ts,
    node: (
      <Arrival
        arrival={arrival}
        name={nameOf(arrival)}
        canReact={canReact}
        onWave={(eventId) => wave(eventId, WAVE)}
      />
    ),
  }))
}
