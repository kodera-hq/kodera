import { useEffect, useState } from 'react'
import { calendarDay } from '../../i18n/format'

/** How often the day is read again; a divider may say « Aujourd'hui » up to this long after midnight. */
export const CALENDAR_DAY_CHECK_MS = 60_000

/**
 * Today's calendar day in Paris, `YYYY-MM-DD`, read outside render so a render stays pure.
 * It is read again every minute, so « Aujourd'hui » becomes « Hier » once midnight passes
 * with the conversation open. Setting the same day again does not re-render.
 */
export function useCalendarToday(): string {
  const [today, setToday] = useState(() => calendarDay(Date.now()))
  useEffect(() => {
    const timer = window.setInterval(() => setToday(calendarDay(Date.now())), CALENDAR_DAY_CHECK_MS)
    return () => window.clearInterval(timer)
  }, [])
  return today
}
