import { MAX_ALERT_DATE, MONTHS, TIMEZONE } from '../config'

export interface ParsedDateResult {
  ok: boolean
  date?: string
  error?: string
  requiresFutureModeChoice?: boolean
}

export function nowIso(): string {
  return new Date().toISOString()
}

export function formatYmdParts(year: number, month: number, day: number): string {
  return `${String(year).padStart(4, '0')}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`
}

export function getMskDateParts(value: Date | string = new Date()): {
  year: number
  month: number
  day: number
  hour: number
  minute: number
  second: number
} {
  const formatter = new Intl.DateTimeFormat('en-GB', {
    timeZone: TIMEZONE,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false
  })

  const parts = formatter.formatToParts(typeof value === 'string' ? new Date(value) : value)
  const result: Record<string, string> = {}

  parts.forEach((part) => {
    if (part.type !== 'literal') {
      result[part.type] = part.value
    }
  })

  return {
    year: Number(result.year),
    month: Number(result.month),
    day: Number(result.day),
    hour: Number(result.hour),
    minute: Number(result.minute),
    second: Number(result.second)
  }
}

export function getCurrentMskContext(): {
  year: number
  month: number
  day: number
  hour: number
  minute: number
  second: number
  date: string
} {
  const parts = getMskDateParts()
  return {
    ...parts,
    date: formatYmdParts(parts.year, parts.month, parts.day)
  }
}

export function formatDateHuman(date: string): string {
  return new Intl.DateTimeFormat('ru-RU', {
    day: '2-digit',
    month: '2-digit',
    year: 'numeric',
    timeZone: TIMEZONE
  }).format(new Date(`${date}T00:00:00+03:00`))
}

export function formatDateTimeHuman(value: string): string {
  return new Intl.DateTimeFormat('ru-RU', {
    day: '2-digit',
    month: '2-digit',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    timeZone: TIMEZONE
  }).format(new Date(value))
}

export function buildSearchDates(daysCount = 3, startValue?: string): string[] {
  const startParts = startValue ? getMskDateParts(startValue) : getCurrentMskContext()
  const startDate = new Date(`${formatYmdParts(startParts.year, startParts.month, startParts.day)}T00:00:00+03:00`)
  const dates: string[] = []

  for (let index = 0; index < daysCount; index += 1) {
    const nextDate = new Date(startDate)
    nextDate.setUTCDate(startDate.getUTCDate() + index)
    const nextParts = getMskDateParts(nextDate)
    dates.push(formatYmdParts(nextParts.year, nextParts.month, nextParts.day))
  }

  return dates
}

export function addDaysYmd(date: string, days: number): string {
  const base = new Date(`${date}T00:00:00+03:00`)
  base.setUTCDate(base.getUTCDate() + days)
  const parts = getMskDateParts(base)
  return formatYmdParts(parts.year, parts.month, parts.day)
}

export function daysBetweenYmd(left: string, right: string): number {
  const leftDate = new Date(`${left}T00:00:00+03:00`).getTime()
  const rightDate = new Date(`${right}T00:00:00+03:00`).getTime()
  return Math.round((rightDate - leftDate) / 86400000)
}

export function isValidYmd(date: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    return false
  }

  const [yearRaw, monthRaw, dayRaw] = date.split('-')
  const year = Number(yearRaw)
  const month = Number(monthRaw)
  const day = Number(dayRaw)
  const parsed = new Date(`${date}T00:00:00+03:00`)
  const parts = getMskDateParts(parsed)

  return parts.year === year && parts.month === month && parts.day === day
}

export function parseFlexibleDateInput(input: string): ParsedDateResult {
  const current = getCurrentMskContext()
  const normalized = String(input || '')
    .toLowerCase()
    .replace(/,/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()

  if (!normalized) {
    return { ok: false, error: 'Дата не указана.' }
  }

  const candidates: Array<{ year: number; month: number; day: number }> = []

  let match = normalized.match(/^(\d{4})[.\-/ ](\d{1,2})[.\-/ ](\d{1,2})$/)
  if (match) {
    candidates.push({
      year: Number(match[1]),
      month: Number(match[2]),
      day: Number(match[3])
    })
  }

  match = normalized.match(/^(\d{1,2})[.\-/ ](\d{1,2})(?:[.\-/ ](\d{2,4}))?$/)
  if (match) {
    candidates.push({
      day: Number(match[1]),
      month: Number(match[2]),
      year: match[3] ? Number(match[3]) : current.year
    })
  }

  match = normalized.match(/^(\d{1,2})$/)
  if (match) {
    candidates.push({
      day: Number(match[1]),
      month: current.month,
      year: current.year
    })
  }

  match = normalized.match(/^(\d{1,2})\s+([а-яё]+)(?:\s+(\d{4}))?$/)
  if (match && MONTHS[match[2]]) {
    candidates.push({
      day: Number(match[1]),
      month: MONTHS[match[2]],
      year: match[3] ? Number(match[3]) : current.year
    })
  }

  match = normalized.match(/^([а-яё]+)\s+(\d{1,2})(?:\s+(\d{4}))?$/)
  if (match && MONTHS[match[1]]) {
    candidates.push({
      day: Number(match[2]),
      month: MONTHS[match[1]],
      year: match[3] ? Number(match[3]) : current.year
    })
  }

  for (const candidate of candidates) {
    const formatted = formatYmdParts(candidate.year, candidate.month, candidate.day)
    if (!isValidYmd(formatted)) {
      continue
    }

    if (formatted < current.date) {
      return { ok: false, error: 'Нельзя подписаться на прошедшую дату.' }
    }

    if (formatted > MAX_ALERT_DATE) {
      return { ok: false, error: `Дата должна быть не позже ${formatDateHuman(MAX_ALERT_DATE)}.` }
    }

    return {
      ok: true,
      date: formatted,
      requiresFutureModeChoice: daysBetweenYmd(current.date, formatted) > 2
    }
  }

  return {
    ok: false,
    error: 'Не понял дату. Поддерживаются форматы: 26, 26.07, 26/07/2026, 2026-07-26, 26 июля.'
  }
}
