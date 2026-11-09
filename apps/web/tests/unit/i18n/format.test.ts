// Exact-string assertions for the money/percent/date formatters, in both
// locales, including the French no-break-space typography that a template
// string would silently get wrong (docs/dev/I18N.md).
import i18next from 'i18next'
import { beforeAll, describe, expect, it } from 'vitest'

import {
  formatDate,
  formatDateTime,
  formatElapsed,
  formatMoney,
  formatPercent,
  formatTime,
  formatWeekdayDate,
  calendarDay,
  previousCalendarDay,
  formatDayDivider,
  minutesToWholeHours,
} from '@/i18n/format'
import '@/i18n/index'

// U+00A0 NO-BREAK SPACE and U+202F NARROW NO-BREAK SPACE render identically
// to the eye and are easy to mistake for a plain space or for each other; the
// literal escapes make the assertion say exactly which one is expected.
const NBSP = ' '
const NNBSP = ' '

describe('formatMoney', () => {
  it('formats French money with a comma decimal and a no-break space before the sign', () => {
    expect(formatMoney({ amount_minor: 599, currency: 'EUR' }, 'fr')).toBe(`5,99${NBSP}€`)
  })

  it('formats English money with the symbol before the amount and a dot decimal', () => {
    expect(formatMoney({ amount_minor: 599, currency: 'EUR' }, 'en')).toBe('€5.99')
  })

  it('groups French thousands with a narrow no-break space, and drops decimals for a whole amount', () => {
    expect(formatMoney({ amount_minor: 149000, currency: 'EUR' }, 'fr')).toBe(
      `1${NNBSP}490${NBSP}€`
    )
  })

  it('never divides outside this module: minor units in, major units out', () => {
    expect(formatMoney({ amount_minor: 1, currency: 'EUR' }, 'en')).toBe('€0.01')
  })

  it('renders a whole French amount with no decimals', () => {
    expect(formatMoney({ amount_minor: 71100, currency: 'EUR' }, 'fr')).toBe(`711${NBSP}€`)
  })

  it('renders a whole English amount with no decimals', () => {
    expect(formatMoney({ amount_minor: 71100, currency: 'EUR' }, 'en')).toBe('€711')
  })

  it('keeps two decimals for a fractional French amount', () => {
    expect(formatMoney({ amount_minor: 40320, currency: 'EUR' }, 'fr')).toBe(`403,20${NBSP}€`)
  })

  it('keeps two decimals for a fractional English amount', () => {
    expect(formatMoney({ amount_minor: 40320, currency: 'EUR' }, 'en')).toBe('€403.20')
  })

  it('drops decimals for a larger whole French amount', () => {
    expect(formatMoney({ amount_minor: 1250000, currency: 'EUR' }, 'fr')).toBe(
      `12${NNBSP}500${NBSP}€`
    )
  })

  it('drops decimals for a larger whole English amount', () => {
    expect(formatMoney({ amount_minor: 1250000, currency: 'EUR' }, 'en')).toBe('€12,500')
  })
})

describe('formatPercent', () => {
  it('formats a French percentage with a no-break space before the sign', () => {
    expect(formatPercent(92, 'fr')).toBe(`92${NBSP}%`)
  })

  it('formats an English percentage with no space', () => {
    expect(formatPercent(92, 'en')).toBe('92%')
  })
})

describe('formatDate', () => {
  it('renders a French date in full', () => {
    expect(formatDate('2026-09-02', 'fr')).toBe('2 septembre 2026')
  })

  it('renders an English date in full, day before month', () => {
    expect(formatDate('2026-09-02', 'en')).toBe('2 September 2026')
  })

  it('is stable for a timestamp near midnight UTC (date-only semantics)', () => {
    expect(formatDate('2026-01-01T00:30:00Z', 'fr')).toBe('1 janvier 2026')
  })
})

describe('formatDateTime', () => {
  it('renders a French date and time', () => {
    expect(formatDateTime('2026-09-02T15:30:00Z', 'fr')).toBe('2 septembre 2026 à 17:30')
  })

  it('renders an English date and time', () => {
    expect(formatDateTime('2026-09-02T15:30:00Z', 'en')).toBe('2 September 2026 at 17:30')
  })
})

describe('formatWeekdayDate', () => {
  it('renders the French weekday, day and month with no year', () => {
    expect(formatWeekdayDate('2026-09-02T08:00:00Z', 'fr')).toBe('mercredi 2 septembre')
  })

  it('renders the English weekday, day and month with no year', () => {
    expect(formatWeekdayDate('2026-09-02T08:00:00Z', 'en')).toBe('Wednesday 2 September')
  })
})

describe('formatTime', () => {
  it('renders a French clock reading in Europe/Paris local time', () => {
    expect(formatTime('2026-09-02T15:30:00Z', 'fr')).toBe('17:30')
  })

  it('renders an English clock reading in Europe/Paris local time', () => {
    expect(formatTime('2026-09-02T15:30:00Z', 'en')).toBe('17:30')
  })
})

describe('minutesToWholeHours', () => {
  it('rounds up so the promise is never generous', () => {
    expect(minutesToWholeHours(240)).toBe(4)
    expect(minutesToWholeHours(241)).toBe(5)
  })

  it('never rounds down to zero hours', () => {
    expect(minutesToWholeHours(30)).toBe(1)
  })
})

describe('plurals through i18next', () => {
  beforeAll(async () => {
    await i18next.changeLanguage('fr')
  })

  it('uses the French singular category for zero, unlike English', async () => {
    // fr's CLDR plural rule maps 0 to the "one" category, same as 1
    // (Intl.PluralRules('fr').select(0) === 'one') — French uses the
    // singular for "0 personne". The catalogue's "one" text for this key
    // interpolates {{count}}, so a count of 0 renders "Envoyer 0 invitation"
    // (singular wording, correct count) rather than the plural.
    await i18next.changeLanguage('fr')
    expect(i18next.t('console.people.invite.action-send', { count: 0 })).toBe(
      'Envoyer 0 invitation'
    )
  })

  it('uses the French singular for exactly one', () => {
    expect(i18next.t('console.people.invite.action-send', { count: 1 })).toBe(
      'Envoyer 1 invitation'
    )
  })

  it('uses the French plural above one', () => {
    expect(i18next.t('console.people.invite.action-send', { count: 3 })).toBe(
      'Envoyer 3 invitations'
    )
  })

  it('uses the English plural for zero, unlike French', async () => {
    await i18next.changeLanguage('en')
    expect(i18next.t('console.people.invite.action-send', { count: 0 })).toBe('Send 0 invitations')
  })

  it('uses the English singular for exactly one', () => {
    expect(i18next.t('console.people.invite.action-send', { count: 1 })).toBe('Send 1 invitation')
  })

  it('uses the English plural above one', () => {
    expect(i18next.t('console.people.invite.action-send', { count: 3 })).toBe('Send 3 invitations')
  })
})

describe('formatTime', () => {
  it('renders a French time in Europe/Paris, no date', () => {
    expect(formatTime('2026-09-02T13:30:00Z', 'fr')).toBe('15:30')
  })
})

describe('formatElapsed', () => {
  // CLDR's French unit data does not use one space character consistently:
  // seconds, hours and days take the narrow no-break space (NNBSP), minutes
  // take the plain no-break space (NBSP) — both real, both asserted exactly
  // rather than guessed at, the same discipline the money tests above apply.
  it('renders seconds under a minute', () => {
    expect(formatElapsed(40, 'fr')).toBe(`40${NNBSP}s`)
  })

  it('renders minutes under an hour', () => {
    expect(formatElapsed(300, 'fr')).toBe(`5${NBSP}min`)
  })

  it('renders hours under a day', () => {
    expect(formatElapsed(7200, 'fr')).toBe(`2${NNBSP}h`)
  })

  it('renders days at and above 24 hours', () => {
    expect(formatElapsed(3 * 86400, 'fr')).toBe(`3${NNBSP}j`)
  })

  it('never renders a negative magnitude', () => {
    expect(formatElapsed(-5, 'fr')).toBe(`0${NNBSP}s`)
  })

  it('renders an English magnitude in its own unit words', () => {
    expect(formatElapsed(40, 'en')).toBe('40 secs')
  })
})

describe('calendarDay', () => {
  it('names the day in Paris, not in UTC, either side of Paris midnight', () => {
    // 23:30 UTC on 4 November is 00:30 on the 5th in Paris (UTC+1 in winter).
    expect(calendarDay(Date.parse('2026-11-04T23:30:00Z'))).toBe('2026-11-05')
    expect(calendarDay(Date.parse('2026-11-04T22:30:00Z'))).toBe('2026-11-04')
    // In summer Paris is UTC+2: 22:30 UTC is already the next day.
    expect(calendarDay(Date.parse('2026-07-01T22:30:00Z'))).toBe('2026-07-02')
  })
})

describe('previousCalendarDay', () => {
  it('steps back one calendar day across a month, a year and a daylight-saving change', () => {
    expect(previousCalendarDay('2026-11-05')).toBe('2026-11-04')
    expect(previousCalendarDay('2026-03-01')).toBe('2026-02-28')
    expect(previousCalendarDay('2027-01-01')).toBe('2026-12-31')
    // Paris leaves summer time on 25 October 2026: that day has 25 hours.
    expect(previousCalendarDay('2026-10-26')).toBe('2026-10-25')
  })
})

describe('formatDayDivider', () => {
  it('renders a capitalised French weekday, day and month, with no year', () => {
    expect(formatDayDivider(Date.parse('2026-11-03T09:00:00Z'), 'fr', false)).toBe(
      'Mardi 3 novembre'
    )
  })

  it('adds the year when asked', () => {
    expect(formatDayDivider(Date.parse('2025-12-30T09:00:00Z'), 'fr', true)).toBe(
      'Mardi 30 décembre 2025'
    )
  })

  it('renders the English weekday, day and month', () => {
    expect(formatDayDivider(Date.parse('2026-11-03T09:00:00Z'), 'en', false)).toBe(
      'Tuesday 3 November'
    )
  })

  it('takes the day from Paris time', () => {
    // 23:30 UTC on Monday 2 November is Tuesday 3 November in Paris.
    expect(formatDayDivider(Date.parse('2026-11-02T23:30:00Z'), 'fr', false)).toBe(
      'Mardi 3 novembre'
    )
  })
})
