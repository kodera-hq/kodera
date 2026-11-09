// Money, percentage and date formatting for the two supported locales.
//
// docs/dev/I18N.md: "Format money and dates through Intl.NumberFormat /
// Intl.DateTimeFormat with the active locale rather than in a template
// string [...] and hand-written ones drift." Every function here defers to
// `Intl` for punctuation (decimal comma, no-break spaces, grouping) instead
// of hand-rolling French typography — the exact separator characters below
// are asserted in tests/unit/i18n/format.test.ts rather than assumed.
//
// Money arrives from the Core API as minor units (integer cents,
// docs/dev/API_CLIENT.md). This module is the one formatting boundary that
// divides by 100 — nowhere else should.

export type Locale = 'fr' | 'en'

// The console only ever serves French-market tenants (docs/dev/TESTING.md
// pins the end-to-end suite to fr-FR / Europe/Paris); 'en' is the second
// *language*, not a second market, so it maps to en-GB (day-month-year
// dates, symbol-before-amount currency with no space) rather than en-US.
const LOCALE_TAG: Record<Locale, string> = {
  fr: 'fr-FR',
  en: 'en-GB',
}

// Dates and times are pinned to Europe/Paris rather than the runtime's own
// timezone: a customer's invoice date must read the same regardless of where
// their browser's clock is set, and it keeps this module's output
// deterministic in tests regardless of the CI runner's timezone.
const TIME_ZONE = 'Europe/Paris'

export interface Money {
  amount_minor: number
  currency: string
}

export function formatMoney(money: Money, locale: Locale): string {
  const amount = money.amount_minor / 100
  return new Intl.NumberFormat(LOCALE_TAG[locale], {
    style: 'currency',
    currency: money.currency,
    // A whole amount ("711 €") reads cleaner than a padded one ("711,00 €"),
    // while a fractional amount still needs its two digits ("5,99 €" must
    // not collapse to "6 €"). `minimumFractionDigits: 2` combined with
    // `trailingZeroDisplay: 'stripIfInteger'` gets both.
    minimumFractionDigits: 2,
    trailingZeroDisplay: 'stripIfInteger',
  }).format(amount)
}

// `HelpContext.sla.first_response_target_minutes` arrives in minutes; the
// catalogue's support-card sentence ("sous {hours} heures ouvrées") wants
// hours. Rounded up so a target of, say, 90 minutes never reads as a promise
// the console cannot keep ("sous 1 heure" for 90 minutes would be wrong in
// the generous direction; "sous 2 heures" is not). Kept here rather than
// inline in the component, with every other division this module owns.
export function minutesToWholeHours(minutes: number): number {
  return Math.max(1, Math.ceil(minutes / 60))
}

// `pct` is the percentage value itself (92 for "92 %"), matching how the
// Core API reports capacity and availability figures — not a 0-1 fraction.
export function formatPercent(pct: number, locale: Locale): string {
  return new Intl.NumberFormat(LOCALE_TAG[locale], { style: 'percent' }).format(pct / 100)
}

// `iso` is a calendar date with no time-of-day meaning ("2026-09-02"), or the
// date part of a full timestamp. Formatted in UTC deliberately: a date-only
// ISO string parses as UTC midnight per the ES spec, and reformatting it in
// any other timezone can shift it to the previous or next day depending on
// the offset — the one thing a "date" must never do.
export function formatDate(iso: string, locale: Locale): string {
  return new Intl.DateTimeFormat(LOCALE_TAG[locale], {
    dateStyle: 'long',
    timeZone: 'UTC',
  }).format(new Date(iso))
}

// `iso` is a full timestamp. Shown in Europe/Paris local time, unlike
// formatDate's UTC — see the TIME_ZONE comment above.
export function formatDateTime(iso: string, locale: Locale): string {
  return new Intl.DateTimeFormat(LOCALE_TAG[locale], {
    dateStyle: 'long',
    timeStyle: 'short',
    timeZone: TIME_ZONE,
  }).format(new Date(iso))
}

// The Home greeting's own date line ("mardi 2 septembre") — weekday and day
// and month, deliberately no year: the buyer reads this the morning they
// open the console, not a document that outlives the year. Shown in
// Europe/Paris local time, like formatDateTime: "today" has to agree with
// the customer's own clock, not UTC's.
export function formatWeekdayDate(iso: string, locale: Locale): string {
  return new Intl.DateTimeFormat(LOCALE_TAG[locale], {
    weekday: 'long',
    day: 'numeric',
    month: 'long',
    timeZone: TIME_ZONE,
  }).format(new Date(iso))
}

// A clock reading only ("17:30") for a timestamp already dated elsewhere on
// the same line — the capacity gauge's "last refused connection at" and the
// applications card's backup time both need the hour without repeating the
// day. Europe/Paris local time, like formatDateTime.
export function formatTime(iso: string, locale: Locale): string {
  return new Intl.DateTimeFormat(LOCALE_TAG[locale], {
    timeStyle: 'short',
    timeZone: TIME_ZONE,
  }).format(new Date(iso))
}

// A short, unitful magnitude — "40 s", "5 min", "2 h", "3 j" — for a
// catalogue sentence that already carries its own "ago" wording ("Mis à jour
// il y a {duration}"): `Intl.RelativeTimeFormat` bakes that wording in and
// would double it up, so this is `Intl.NumberFormat`'s `unit` style instead,
// on the coarsest unit that keeps the number under 60. The caller computes
// the elapsed seconds against its own clock; this module only formats.
export function formatElapsed(seconds: number, locale: Locale): string {
  const abs = Math.max(0, Math.round(seconds))
  const [value, unit]: [number, 'second' | 'minute' | 'hour' | 'day'] =
    abs < 60
      ? [abs, 'second']
      : abs < 3600
        ? [Math.round(abs / 60), 'minute']
        : abs < 86400
          ? [Math.round(abs / 3600), 'hour']
          : [Math.round(abs / 86400), 'day']
  return new Intl.NumberFormat(LOCALE_TAG[locale], {
    style: 'unit',
    unit,
    unitDisplay: 'short',
  }).format(value)
}

// The calendar day a moment falls on in Europe/Paris, as `YYYY-MM-DD`: the
// timeline's day dividers group messages by it, so two messages on either
// side of Paris midnight are never drawn under one day, whatever the
// browser's own timezone. Built from the parts, so no locale's own date shape
// is relied on, and with one formatter: the log reads it for every message on
// every draw.
const CALENDAR_DAY = new Intl.DateTimeFormat('en-GB', {
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
  timeZone: TIME_ZONE,
})

export function calendarDay(ms: number): string {
  const parts = Object.fromEntries(
    CALENDAR_DAY.formatToParts(new Date(ms)).map((part) => [part.type, part.value])
  )
  return `${parts.year}-${parts.month}-${parts.day}`
}

// The day before a `YYYY-MM-DD` calendar day, by date arithmetic rather than
// by subtracting 24 hours, which a daylight-saving change makes wrong.
export function previousCalendarDay(day: string): string {
  const [year, month, date] = day.split('-').map(Number)
  return new Date(Date.UTC(year!, month! - 1, date! - 1)).toISOString().slice(0, 10)
}

// A day divider's label for a day that is neither today nor yesterday: the
// weekday, the day and the month ("Mardi 4 novembre"), and the year only when
// it is not the current one. Capitalised, since it stands alone as a label,
// like « Aujourd'hui » and « Hier » beside it.
const DAY_DIVIDER = new Map<string, Intl.DateTimeFormat>()

export function formatDayDivider(ms: number, locale: Locale, withYear: boolean): string {
  const key = `${locale}:${withYear}`
  let format = DAY_DIVIDER.get(key)
  if (format === undefined) {
    format = new Intl.DateTimeFormat(LOCALE_TAG[locale], {
      weekday: 'long',
      day: 'numeric',
      month: 'long',
      ...(withYear ? { year: 'numeric' } : {}),
      timeZone: TIME_ZONE,
    })
    DAY_DIVIDER.set(key, format)
  }
  const text = format.format(new Date(ms))
  return text.charAt(0).toLocaleUpperCase(LOCALE_TAG[locale]) + text.slice(1)
}
